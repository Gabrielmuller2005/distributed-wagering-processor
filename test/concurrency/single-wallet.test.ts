import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WagerTransactionResult } from "../../src/wagering/application/views";
import { FailureCode } from "../../src/wagering/domain/failure-code";
import { openTestDatabase, type TestDatabase } from "../helpers/database";
import { expectLedgerMatchesWallet } from "../helpers/invariants";
import { openWallet, useCases, wagerCommand } from "../helpers/use-cases";

/**
 * Concorrência real: as submissões rodam ao mesmo tempo, cada uma na sua conexão do pool e na
 * sua transação SQL, disputando o lock da mesma wallet no PostgreSQL. Nada é serializado no
 * processo de teste. Os mesmos cenários com vários processos: multi-instance.test.ts.
 */

let db: TestDatabase;
let cases: ReturnType<typeof useCases>;

beforeAll(async () => {
  db = await openTestDatabase();
  cases = useCases(db.unitOfWork);
});

afterAll(async () => {
  await db.close();
});

const money = (amount: string) => ({ amount, currency: "BRL" });
const count = (results: WagerTransactionResult[], status: string) =>
  results.filter((result) => result.status === status).length;

describe("seção 8: cenário obrigatório", () => {
  test("100.00 BRL e duas apostas de 80.00 simultâneas: uma PROCESSED, uma REJECTED, saldo 20.00, um débito", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    const first = wagerCommand(wallet, { money: money("80.00") });
    const second = wagerCommand(wallet, { money: money("80.00") });

    const results = await Promise.all([cases.submit.execute(first), cases.submit.execute(second)]);

    expect(count(results, "PROCESSED")).toBe(1);
    expect(count(results, "REJECTED")).toBe(1);
    expect(results.find((result) => result.status === "REJECTED")?.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toEqual({
      balance: "20.00",
      entries: 2,
      debits: 1,
      credits: 1,
    });

    // "Nenhum retry duplica o débito": reenviar as duas, várias vezes e em paralelo, só faz replay.
    const retries = await Promise.all(
      [first, second, first, second, first, second].map((command) => cases.submit.execute(command)),
    );
    expect(retries.every((result) => result.idempotentReplay)).toBe(true);
    expect(retries.map((result) => result.status).sort()).toEqual(
      [...results, ...results, ...results].map((result) => result.status).sort(),
    );
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).debits).toBe(1);
  });

  test("o cenário se mantém em 25 repetições, cada uma numa wallet nova", async () => {
    for (let round = 0; round < 25; round++) {
      const wallet = await openWallet(cases.createWallet, "100.00");

      const results = await Promise.all([
        cases.submit.execute(wagerCommand(wallet, { money: money("80.00") })),
        cases.submit.execute(wagerCommand(wallet, { money: money("80.00") })),
      ]);

      expect([count(results, "PROCESSED"), count(results, "REJECTED")]).toEqual([1, 1]);
      expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).balance).toBe("20.00");
    }
  });
});

describe("idempotência sob concorrência", () => {
  test("a mesma aposta enviada 50 vezes em paralelo: um único débito, 49 replays idênticos", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    const command = wagerCommand(wallet, { money: money("25.00") });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => cases.submit.execute(command)),
    );

    const original = results.filter((result) => !result.idempotentReplay);
    expect(original).toHaveLength(1);
    expect(results.every((result) => result.transactionId === original[0]?.transactionId)).toBe(
      true,
    );
    expect(results.every((result) => result.status === "PROCESSED")).toBe(true);
    expect(results.every((result) => result.balance?.amount === "75.00")).toBe(true);
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
      balance: "75.00",
      debits: 1,
    });
  });

  test("mesma chave com payloads diferentes em paralelo: um vence, os outros são conflito", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    const base = wagerCommand(wallet, { money: money("10.00") });
    const variants = ["10.00", "11.00", "12.00", "13.00", "14.00"].map((amount) => ({
      ...base,
      transaction: { ...base.transaction, money: money(amount) },
    }));

    const settled = await Promise.allSettled(
      variants.map((command) => cases.submit.execute(command)),
    );

    const fulfilled = settled.filter((outcome) => outcome.status === "fulfilled");
    const rejected = settled.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    }
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).debits).toBe(1);
  });
});

describe("disputa pelo saldo", () => {
  test("30 apostas de 10.00 simultâneas sobre 100.00: exatamente 10 passam, saldo nunca negativo", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        cases.submit.execute(wagerCommand(wallet, { money: money("10.00") })),
      ),
    );

    expect(count(results, "PROCESSED")).toBe(10);
    expect(count(results, "REJECTED")).toBe(20);
    expect(results.every((result) => !result.balance?.amount.startsWith("-"))).toBe(true);
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toEqual({
      balance: "0.00",
      entries: 11,
      debits: 10,
      credits: 1,
    });
  });

  test("apostas e ganhos misturados em paralelo: o saldo final é exatamente a soma", async () => {
    const wallet = await openWallet(cases.createWallet, "1000.00");
    const commands = Array.from({ length: 40 }, (_, i) =>
      wagerCommand(wallet, {
        kind: i % 2 === 0 ? "BET" : "WIN",
        money: money(i % 2 === 0 ? "7.35" : "2.10"),
      }),
    );

    const results = await Promise.all(commands.map((command) => cases.submit.execute(command)));

    expect(count(results, "PROCESSED")).toBe(40);
    // 1000.00 - 20 × 7.35 + 20 × 2.10 = 1000.00 - 147.00 + 42.00
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).balance).toBe("895.00");
  });
});

describe("wallets diferentes em paralelo", () => {
  test("10 wallets com 5 apostas simultâneas cada: nenhuma interfere na outra", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => openWallet(cases.createWallet, "50.00")),
    );

    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () =>
          cases.submit.execute(wagerCommand(wallet, { money: money("10.00") })),
        ),
      ),
    );

    for (const wallet of wallets) {
      expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
        balance: "0.00",
        debits: 5,
      });
    }
  });
});

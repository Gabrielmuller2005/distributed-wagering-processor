import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ValidationError,
  WalletAlreadyExistsError,
} from "../../../src/wagering/application/errors";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import { expectLedgerMatchesWallet } from "../../helpers/invariants";
import { openWallet, useCases } from "../../helpers/use-cases";

let db: TestDatabase;
let createWallet: ReturnType<typeof useCases>["createWallet"];

beforeAll(async () => {
  db = await openTestDatabase();
  ({ createWallet } = useCases(db.unitOfWork));
});

afterAll(async () => {
  await db.close();
});

async function outboxEventTypes(aggregateId: string): Promise<string[]> {
  const rows = await db.sql<{ event_type: string }[]>(
    "select event_type from outbox_messages where aggregate_id = ? order by id",
    [aggregateId],
  );
  return rows.map((row) => row.event_type);
}

describe("CreateWallet", () => {
  test("devolve a wallet no formato do enunciado, com version 1", async () => {
    const playerId = newId();

    const wallet = await openWallet(createWallet, "1000.00", playerId);

    expect(wallet).toEqual({
      id: wallet.id,
      playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
  });

  test("saldo inicial gera OPENING PROCESSED + crédito no ledger + eventos, na mesma transação", async () => {
    const wallet = await openWallet(createWallet, "1000.00");

    const [opening] = await db.sql<{ kind: string; status: string; amount: string }[]>(
      "select kind, status, amount from wager_transactions where wallet_id = ?",
      [wallet.id],
    );
    const check = await expectLedgerMatchesWallet(db.unitOfWork, wallet.id);

    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED", amount: "1000.00" });
    expect(check).toEqual({ balance: "1000.00", entries: 1, debits: 0, credits: 1 });
    expect(await outboxEventTypes(wallet.id)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("saldo inicial zero não gera transação, lançamento nem eventos", async () => {
    const wallet = await openWallet(createWallet, "0.00");

    const transactions = await db.sql<unknown[]>(
      "select 1 from wager_transactions where wallet_id = ?",
      [wallet.id],
    );

    expect(transactions).toHaveLength(0);
    expect(await outboxEventTypes(wallet.id)).toEqual([]);
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).entries).toBe(0);
  });

  test("wallet duplicada para o mesmo player e moeda é conflito, e nada muda", async () => {
    const playerId = newId();
    const first = await openWallet(createWallet, "100.00", playerId);

    await expect(openWallet(createWallet, "50.00", playerId)).rejects.toBeInstanceOf(
      WalletAlreadyExistsError,
    );
    const wallets = await db.sql<unknown[]>("select 1 from wallets where player_id = ?", [
      playerId,
    ]);
    expect(wallets).toHaveLength(1);
    await expectLedgerMatchesWallet(db.unitOfWork, first.id);
  });

  test("o mesmo player pode abrir wallets em moedas diferentes", async () => {
    const playerId = newId();
    await openWallet(createWallet, "100.00", playerId);

    const usd = await createWallet.execute({
      playerId,
      initialBalance: { amount: "5.00", currency: "USD" },
      correlationId: newId(),
    });

    expect(usd.balance).toEqual({ amount: "5.00", currency: "USD" });
  });

  test.each([
    ["playerId vazio", { playerId: " ", initialBalance: { amount: "1.00", currency: "BRL" } }],
    ["playerId não string", { playerId: 42, initialBalance: { amount: "1.00", currency: "BRL" } }],
    ["saldo negativo", { playerId: "p", initialBalance: { amount: "-1.00", currency: "BRL" } }],
    ["saldo como número", { playerId: "p", initialBalance: { amount: 10, currency: "BRL" } }],
    ["moeda inválida", { playerId: "p", initialBalance: { amount: "1.00", currency: "R$" } }],
    ["sem saldo inicial", { playerId: "p", initialBalance: undefined }],
  ])("entrada inválida (%s) é ValidationError e não grava nada", async (_name, input) => {
    await expect(createWallet.execute({ ...input, correlationId: newId() })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

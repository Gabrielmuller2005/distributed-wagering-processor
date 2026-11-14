import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  InboxConflictError,
  ValidationError,
  WalletNotFoundError,
} from "../../../src/wagering/application/errors";
import type { SubmitWagerTransactionCommand } from "../../../src/wagering/application/use-cases/submit-wager-transaction";
import type { WalletView } from "../../../src/wagering/application/views";
import { WagerTransactionStatus } from "../../../src/wagering/domain/wager-transaction/wager-transaction-status";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId, sha256 } from "../../helpers/fixtures";
import { expectLedgerMatchesWallet } from "../../helpers/invariants";
import { openWallet, useCases, wagerCommand } from "../../helpers/use-cases";

let db: TestDatabase;
let cases: ReturnType<typeof useCases>;

beforeAll(async () => {
  db = await openTestDatabase();
  cases = useCases(db.unitOfWork);
});

afterAll(async () => {
  await db.close();
});

const submit = (command: SubmitWagerTransactionCommand) => cases.submit.execute(command);
const newWallet = (amount = "100.00") => openWallet(cases.createWallet, amount);
const money = (amount: string) => ({ amount, currency: "BRL" });

async function balanceOf(wallet: WalletView): Promise<string> {
  const [row] = await db.sql<{ balance: string }[]>("select balance from wallets where id = ?", [
    wallet.id,
  ]);
  return row?.balance ?? "";
}

/** Tipos dos eventos gravados na outbox para uma transação. */
async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = await db.sql<{ event_type: string }[]>(
    "select event_type from outbox_messages where payload -> 'data' ->> 'transactionId' = ? order by id",
    [transactionId],
  );
  return rows.map((row) => row.event_type);
}

/** Submete e devolve o resultado; útil para referências. */
async function processed(wallet: WalletView, transaction: Record<string, unknown>) {
  const command = wagerCommand(wallet, transaction);
  const result = await submit(command);
  expect(result.status).toBe(WagerTransactionStatus.Processed);
  return { command, result };
}

describe("seção 7: cada tipo de operação", () => {
  test("BET debita, responde no formato do enunciado e grava os eventos", async () => {
    const wallet = await newWallet("1000.00");

    const result = await submit(wagerCommand(wallet, { money: money("25.00") }));

    expect(result).toEqual({
      transactionId: result.transactionId,
      status: "PROCESSED",
      balance: money("975.00"),
      idempotentReplay: false,
    } as typeof result);
    expect(await eventsOf(result.transactionId)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toEqual({
      balance: "975.00",
      entries: 2,
      debits: 1,
      credits: 1,
    });
  });

  test("BET sem saldo é REJECTED(INSUFFICIENT_FUNDS), gravada e com evento, sem ledger", async () => {
    const wallet = await newWallet("10.00");

    const result = await submit(wagerCommand(wallet, { money: money("25.00") }));

    expect(result).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      failureCategory: "FINAL",
      balance: money("10.00"),
      idempotentReplay: false,
    });
    expect(await eventsOf(result.transactionId)).toEqual(["WagerTransactionRejected"]);
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).debits).toBe(0);
  });

  test("WIN credita", async () => {
    const wallet = await newWallet("100.00");

    const result = await submit(wagerCommand(wallet, { kind: "WIN", money: money("40.00") }));

    expect(result.balance).toEqual(money("140.00"));
    await expectLedgerMatchesWallet(db.unitOfWork, wallet.id);
  });

  test("WIN referenciando a BET da rodada", async () => {
    const wallet = await newWallet("100.00");
    const bet = await processed(wallet, { money: money("25.00") });

    const result = await submit(
      wagerCommand(wallet, {
        kind: "WIN",
        money: money("60.00"),
        referenceExternalTransactionId: bet.command.transaction.externalTransactionId,
      }),
    );

    expect(result).toMatchObject({ status: "PROCESSED", balance: money("135.00") });
  });

  test("LOSS é PROCESSED sem mover saldo, sem ledger e sem WalletBalanceChanged", async () => {
    const wallet = await newWallet("100.00");

    const result = await submit(wagerCommand(wallet, { kind: "LOSS", money: money("0.00") }));

    expect(result).toMatchObject({ status: "PROCESSED", balance: money("100.00") });
    expect(await eventsOf(result.transactionId)).toEqual(["WagerTransactionProcessed"]);
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).entries).toBe(1);
  });

  test("REFUND de BET PROCESSED devolve o valor", async () => {
    const wallet = await newWallet("100.00");
    const bet = await processed(wallet, { money: money("30.00") });

    const result = await submit(
      wagerCommand(wallet, {
        kind: "REFUND",
        money: money("30.00"),
        referenceExternalTransactionId: bet.command.transaction.externalTransactionId,
      }),
    );

    expect(result).toMatchObject({ status: "PROCESSED", balance: money("100.00") });
    await expectLedgerMatchesWallet(db.unitOfWork, wallet.id);
  });

  test.each([
    ["BET", "100.00"],
    ["WIN", "100.00"],
  ])("ROLLBACK de %s faz o inverso e volta a %s", async (kind, expected) => {
    const wallet = await newWallet("100.00");
    const reference = await processed(wallet, { kind, money: money("30.00") });

    const result = await submit(
      wagerCommand(wallet, {
        kind: "ROLLBACK",
        money: money("30.00"),
        referenceExternalTransactionId: reference.command.transaction.externalTransactionId,
      }),
    );

    expect(result).toMatchObject({ status: "PROCESSED", balance: money(expected) });
    await expectLedgerMatchesWallet(db.unitOfWork, wallet.id);
  });
});

describe("seção 7: referências e reversões", () => {
  const reversal = (wallet: WalletView, kind: string, reference: string, amount = "30.00") =>
    wagerCommand(wallet, {
      kind,
      money: money(amount),
      referenceExternalTransactionId: reference,
    });

  test("referência ausente → PENDING_REFERENCE agendada, com evento, sem mexer no saldo", async () => {
    const wallet = await newWallet("100.00");

    const result = await submit(reversal(wallet, "REFUND", "bet-not-arrived"));

    const [row] = await db.sql<{ status: string; next_reference_attempt_at: string | null }[]>(
      "select status, next_reference_attempt_at from wager_transactions where id = ?",
      [result.transactionId],
    );
    expect(result).toMatchObject({ status: "PENDING_REFERENCE", balance: null });
    expect(row?.next_reference_attempt_at).not.toBeNull();
    expect(await eventsOf(result.transactionId)).toEqual(["WagerTransactionPendingReference"]);
    expect(await balanceOf(wallet)).toBe("100.00");
  });

  test("segunda reversão da mesma BET → REJECTED(ALREADY_REVERSED), sem crédito duplicado", async () => {
    const wallet = await newWallet("100.00");
    const bet = await processed(wallet, { money: money("30.00") });
    const ref = bet.command.transaction.externalTransactionId as string;
    await submit(reversal(wallet, "REFUND", ref));

    const rollback = await submit(reversal(wallet, "ROLLBACK", ref));

    expect(rollback).toMatchObject({ status: "REJECTED", failureCode: "ALREADY_REVERSED" });
    expect(await balanceOf(wallet)).toBe("100.00");
    await expectLedgerMatchesWallet(db.unitOfWork, wallet.id);
  });

  test("REFUND com valor diferente → AMOUNT_MISMATCH", async () => {
    const wallet = await newWallet("100.00");
    const bet = await processed(wallet, { money: money("30.00") });

    const result = await submit(
      reversal(wallet, "REFUND", bet.command.transaction.externalTransactionId as string, "10.00"),
    );

    expect(result).toMatchObject({ status: "REJECTED", failureCode: "AMOUNT_MISMATCH" });
  });

  test("REFUND de um WIN → INVALID_REFERENCE_KIND", async () => {
    const wallet = await newWallet("100.00");
    const win = await processed(wallet, { kind: "WIN", money: money("30.00") });

    const result = await submit(
      reversal(wallet, "REFUND", win.command.transaction.externalTransactionId as string),
    );

    expect(result).toMatchObject({ status: "REJECTED", failureCode: "INVALID_REFERENCE_KIND" });
  });

  test("referência de outra rodada → REFERENCE_MISMATCH", async () => {
    const wallet = await newWallet("100.00");
    const bet = await processed(wallet, { money: money("30.00"), roundId: "round-1" });

    const result = await submit(
      wagerCommand(wallet, {
        kind: "REFUND",
        roundId: "round-2",
        money: money("30.00"),
        referenceExternalTransactionId: bet.command.transaction.externalTransactionId,
      }),
    );

    expect(result).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_MISMATCH" });
  });

  test("referência REJECTED → REFERENCE_NOT_PROCESSED", async () => {
    const wallet = await newWallet("10.00");
    const failedBet = wagerCommand(wallet, { money: money("30.00") });
    await submit(failedBet);

    const result = await submit(
      reversal(wallet, "REFUND", failedBet.transaction.externalTransactionId as string),
    );

    expect(result).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_NOT_PROCESSED" });
  });

  test("ROLLBACK de WIN que estouraria o saldo → REVERSAL_WOULD_OVERDRAW (distinto de falta de saldo)", async () => {
    const wallet = await newWallet("10.00");
    const win = await processed(wallet, { kind: "WIN", money: money("50.00") });
    await processed(wallet, { money: money("55.00") });

    const result = await submit(
      reversal(
        wallet,
        "ROLLBACK",
        win.command.transaction.externalTransactionId as string,
        "50.00",
      ),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      failureCode: "REVERSAL_WOULD_OVERDRAW",
      balance: money("5.00"),
    });
    await expectLedgerMatchesWallet(db.unitOfWork, wallet.id);
  });

  test("wallet de outro player → PLAYER_MISMATCH, sem expor o saldo", async () => {
    const wallet = await newWallet("100.00");

    const result = await submit(wagerCommand(wallet, { playerId: "someone-else" }));

    expect(result).toMatchObject({
      status: "REJECTED",
      failureCode: "PLAYER_MISMATCH",
      balance: null,
    });
  });

  test("moeda diferente da wallet → CURRENCY_MISMATCH", async () => {
    const wallet = await newWallet("100.00");

    const result = await submit(
      wagerCommand(wallet, { money: { amount: "10.00", currency: "USD" } }),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      failureCode: "CURRENCY_MISMATCH",
      balance: null,
    });
    expect(await balanceOf(wallet)).toBe("100.00");
  });
});

describe("idempotência", () => {
  test("replay devolve o resultado e o saldo ORIGINAIS, mesmo depois de outras movimentações", async () => {
    const wallet = await newWallet("100.00");
    const command = wagerCommand(wallet, { money: money("25.00") });
    const original = await submit(command);
    await submit(wagerCommand(wallet, { money: money("50.00") }));

    const replay = await submit(command);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance).toEqual(money("75.00"));
    expect(await balanceOf(wallet)).toBe("25.00");
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).debits).toBe(2);
  });

  test("replay de uma rejeição devolve a mesma rejeição, mesmo que agora houvesse saldo", async () => {
    const wallet = await newWallet("10.00");
    const command = wagerCommand(wallet, { money: money("25.00") });
    const original = await submit(command);
    await submit(wagerCommand(wallet, { kind: "WIN", money: money("100.00") }));

    const replay = await submit(command);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
  });

  test("replay não grava eventos novos", async () => {
    const wallet = await newWallet("100.00");
    const command = wagerCommand(wallet);
    const original = await submit(command);

    await submit(command);
    await submit(command);

    expect(await eventsOf(original.transactionId)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("mesma chave com payload diferente é conflito, não replay", async () => {
    const wallet = await newWallet("100.00");
    const command = wagerCommand(wallet, { money: money("25.00") });
    await submit(command);

    const different = {
      ...command,
      transaction: { ...command.transaction, money: money("26.00") },
    };

    await expect(submit(different)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      reason: "PAYLOAD_MISMATCH",
    });
    expect(await balanceOf(wallet)).toBe("75.00");
  });

  test("mesmo externalTransactionId com outra chave é conflito", async () => {
    const wallet = await newWallet("100.00");
    const command = wagerCommand(wallet);
    await submit(command);

    await expect(submit({ ...command, idempotencyKey: `other:${newId()}` })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      reason: "EXTERNAL_ID_REUSED",
    });
  });

  test('"25" e "25.00" são o mesmo payload: replay', async () => {
    const wallet = await newWallet("100.00");
    const command = wagerCommand(wallet, { money: money("25.00") });
    await submit(command);

    const replay = await submit({
      ...command,
      transaction: { ...command.transaction, money: money("25") },
    });

    expect(replay.idempotentReplay).toBe(true);
  });

  test("a ordem das chaves no payload não importa", async () => {
    const wallet = await newWallet("100.00");
    const command = wagerCommand(wallet);
    await submit(command);
    const reordered = Object.fromEntries(Object.entries(command.transaction).reverse());

    const replay = await submit({
      ...command,
      transaction: reordered as typeof command.transaction,
    });

    expect(replay.idempotentReplay).toBe(true);
  });
});

describe("caminho SQS: inbox persistente", () => {
  const inbox = (messageId: string, body = "body") => ({
    consumerName: "wager-transactions-consumer",
    messageId,
    payloadHash: sha256(body),
  });

  test("a mensagem é registrada na inbox na mesma transação, e a redelivery vira replay", async () => {
    const wallet = await newWallet("100.00");
    const messageId = `msg-${newId()}`;
    const command = wagerCommand(wallet, {}, { inbox: inbox(messageId) });

    const first = await submit(command);
    const redelivery = await submit(command);

    const [row] = await db.sql<{ processed_at: string | null }[]>(
      "select processed_at from inbox_messages where message_id = ?",
      [messageId],
    );
    expect(row?.processed_at).not.toBeNull();
    expect(redelivery).toEqual({ ...first, idempotentReplay: true });
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).debits).toBe(1);
  });

  test("mesmo messageId com outro conteúdo é conflito de inbox", async () => {
    const wallet = await newWallet("100.00");
    const messageId = `msg-${newId()}`;
    await submit(wagerCommand(wallet, {}, { inbox: inbox(messageId, "a") }));

    await expect(
      submit(wagerCommand(wallet, {}, { inbox: inbox(messageId, "b") })),
    ).rejects.toBeInstanceOf(InboxConflictError);
  });

  test("os eventos levam o messageId como causationId", async () => {
    const wallet = await newWallet("100.00");
    const messageId = `msg-${newId()}`;
    const command = wagerCommand(wallet, {}, { inbox: inbox(messageId) });

    const result = await submit(command);

    const rows = await db.sql<{ causation: string; correlation: string }[]>(
      `select payload ->> 'causationId' as causation, payload ->> 'correlationId' as correlation
       from outbox_messages where payload -> 'data' ->> 'transactionId' = ?`,
      [result.transactionId],
    );
    expect(rows.every((row) => row.causation === messageId)).toBe(true);
    expect(rows.every((row) => row.correlation === command.correlationId)).toBe(true);
  });
});

describe("entradas inválidas e wallet inexistente", () => {
  test("wallet inexistente: WalletNotFoundError e nada gravado", async () => {
    const wallet = await newWallet("100.00");
    const command = wagerCommand({ ...wallet, id: newId() });

    await expect(submit(command)).rejects.toBeInstanceOf(WalletNotFoundError);
    const rows = await db.sql<unknown[]>(
      "select 1 from wager_transactions where idempotency_key = ?",
      [command.idempotencyKey],
    );
    expect(rows).toHaveLength(0);
  });

  test.each([
    ["sem idempotency key", {}, { idempotencyKey: "" }, "IDEMPOTENCY_KEY_REQUIRED"],
    ["OPENING submetido", { kind: "OPENING" }, {}, "INVALID_KIND"],
    ["kind desconhecido", { kind: "JACKPOT" }, {}, "INVALID_KIND"],
    ["amount como número", { money: { amount: 25, currency: "BRL" } }, {}, "INVALID_AMOUNT"],
    ["amount com 3 casas", { money: money("25.001") }, {}, "INVALID_AMOUNT"],
    ["notação científica", { money: money("1e3") }, {}, "INVALID_AMOUNT"],
    ["BET com valor zero", { money: money("0.00") }, {}, "INVALID_AMOUNT"],
    ["REFUND sem referência", { kind: "REFUND" }, {}, "REFERENCE_REQUIRED"],
    ["BET com referência", { referenceExternalTransactionId: "x" }, {}, "REFERENCE_NOT_ALLOWED"],
    ["roundId ausente", { roundId: undefined }, {}, "MISSING_FIELD"],
    ["walletId não string", { walletId: 123 }, {}, "MISSING_FIELD"],
  ] as const)("%s → ValidationError(%s), nada gravado", async (_n, tx, overrides, reason) => {
    const wallet = await newWallet("100.00");
    const command = wagerCommand(wallet, tx, overrides);

    const attempt = submit(command);

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({ reason });
    expect(await balanceOf(wallet)).toBe("100.00");
  });

  test("conflito de idempotência é erro, não resultado (IdempotencyConflictError)", async () => {
    const wallet = await newWallet("100.00");
    const command = wagerCommand(wallet);
    await submit(command);

    await expect(
      submit({ ...command, transaction: { ...command.transaction, roundId: "other" } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

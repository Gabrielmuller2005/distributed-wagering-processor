import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../../../src/wagering/domain/failure-code";
import { LedgerDirection } from "../../../../src/wagering/domain/ledger/ledger-direction";
import { Money } from "../../../../src/wagering/domain/money";
import {
  applyWagerTransaction,
  InvalidWagerApplicationError,
  type WagerOutcome,
} from "../../../../src/wagering/domain/wager-processing/apply-wager-transaction";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from "../../../../src/wagering/domain/wager-transaction/wager-transaction";
import { WagerTransactionKind as Kind } from "../../../../src/wagering/domain/wager-transaction/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../../../src/wagering/domain/wager-transaction/wager-transaction-status";
import { Wallet } from "../../../../src/wagering/domain/wallet/wallet";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-01-01T00:00:01Z");

let sequence = 0;

function newWallet(balance = "100.00"): Wallet {
  return Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl(balance), at: T0 })
    .wallet;
}

function newTransaction(
  kind: Kind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  sequence += 1;
  return WagerTransaction.create({
    id: `tx-${sequence}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `provider-a:ext-${sequence}`,
    payloadHash: `hash-${sequence}`,
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl(amount),
    createdAt: T0,
    ...overrides,
  });
}

interface ApplyOptions {
  readonly reference?: WagerTransaction;
  readonly referenceAlreadyReversed?: boolean;
}

function apply(
  transaction: WagerTransaction,
  wallet: Wallet,
  options: ApplyOptions = {},
): WagerOutcome {
  return applyWagerTransaction({
    transaction,
    wallet,
    reference: options.reference,
    referenceAlreadyReversed: options.referenceAlreadyReversed ?? false,
    ledgerEntryId: `entry-${transaction.id}`,
    at: T1,
  });
}

/** Cria e processa uma transação, para servir de referência. */
function processed(kind: Kind, amount: string, wallet: Wallet, reference?: WagerTransaction) {
  const tx = newTransaction(kind, amount, {
    referenceExternalTransactionId: reference?.externalTransactionId,
  });
  const outcome = apply(tx, wallet, { reference });
  if (outcome.status !== Status.Processed) throw new Error(`setup: ${kind} not processed`);
  return tx;
}

function reversal(kind: Kind.Refund | Kind.Rollback, reference: WagerTransaction, amount?: string) {
  return newTransaction(kind, amount ?? reference.money.toString(), {
    referenceExternalTransactionId: reference.externalTransactionId,
  });
}

describe("Seção 7: efeito de cada operação no saldo e no ledger", () => {
  test("BET debita e gera 1 lançamento DEBIT", () => {
    const wallet = newWallet("100.00");
    const tx = newTransaction(Kind.Bet, "25.00");

    const outcome = apply(tx, wallet);

    expect(outcome.status).toBe(Status.Processed);
    expect(wallet.balance.toString()).toBe("75.00");
    expect(tx.status).toBe(Status.Processed);
    expect(tx.balanceAfter?.toString()).toBe("75.00");
    expect(tx.processedAt).toEqual(T1);
    if (outcome.status !== Status.Processed) return;
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(outcome.ledgerEntry?.money.toString()).toBe("25.00");
    expect(outcome.ledgerEntry?.balanceBefore.toString()).toBe("100.00");
    expect(outcome.ledgerEntry?.balanceAfter.toString()).toBe("75.00");
    expect(outcome.ledgerEntry?.transactionId).toBe(tx.id);
  });

  test("BET sem saldo é REJECTED(INSUFFICIENT_FUNDS), sem ledger e sem mexer no saldo", () => {
    const wallet = newWallet("10.00");
    const tx = newTransaction(Kind.Bet, "25.00");

    const outcome = apply(tx, wallet);

    expect(outcome).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.balanceAfter?.toString()).toBe("10.00");
    expect(wallet.balance.toString()).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  test("WIN credita e gera 1 lançamento CREDIT", () => {
    const wallet = newWallet("100.00");

    const outcome = apply(newTransaction(Kind.Win, "40.00"), wallet);

    expect(wallet.balance.toString()).toBe("140.00");
    expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Credit,
    );
  });

  test("WIN pode referenciar a BET da mesma rodada", () => {
    const wallet = newWallet("100.00");
    const betTx = processed(Kind.Bet, "25.00", wallet);
    const win = newTransaction(Kind.Win, "50.00", {
      referenceExternalTransactionId: betTx.externalTransactionId,
    });

    apply(win, wallet, { reference: betTx });

    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(betTx.id);
    expect(wallet.balance.toString()).toBe("125.00");
  });

  test("LOSS não mexe no saldo nem gera lançamento, mas é PROCESSED com o saldo observado", () => {
    const wallet = newWallet("100.00");
    const tx = newTransaction(Kind.Loss, "0.00");

    const outcome = apply(tx, wallet);

    expect(outcome).toEqual({ status: Status.Processed, ledgerEntry: undefined });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.balanceAfter?.toString()).toBe("100.00");
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("REFUND de uma BET PROCESSED credita o mesmo valor", () => {
    const wallet = newWallet("100.00");
    const betTx = processed(Kind.Bet, "30.00", wallet);
    const refund = reversal(Kind.Refund, betTx);

    const outcome = apply(refund, wallet, { reference: betTx });

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(betTx.id);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(
      LedgerDirection.Credit,
    );
  });

  test.each([
    [Kind.Bet, "30.00", LedgerDirection.Credit, "100.00"],
    [Kind.Win, "30.00", LedgerDirection.Debit, "100.00"],
  ])("ROLLBACK de %s faz o lançamento inverso (%s %s -> %s)", (kind, amount, direction, final) => {
    const wallet = newWallet("100.00");
    const reference = processed(kind, amount, wallet);
    const rollback = reversal(Kind.Rollback, reference);

    const outcome = apply(rollback, wallet, { reference });

    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.toString()).toBe(final);
    expect(outcome.status === Status.Processed && outcome.ledgerEntry?.direction).toBe(direction);
  });

  test("ROLLBACK de REFUND debita de novo o valor estornado", () => {
    const wallet = newWallet("100.00");
    const betTx = processed(Kind.Bet, "30.00", wallet);
    const refund = processed(Kind.Refund, "30.00", wallet, betTx);
    const rollback = reversal(Kind.Rollback, refund);

    apply(rollback, wallet, { reference: refund });

    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.toString()).toBe("70.00");
  });
});

describe("Seção 7: regras de referência", () => {
  test("regra 8: referência ausente → PENDING_REFERENCE, sem mexer no saldo", () => {
    const wallet = newWallet("100.00");
    const refund = newTransaction(Kind.Refund, "30.00", {
      referenceExternalTransactionId: "ext-not-arrived",
    });

    const outcome = apply(refund, wallet);

    expect(outcome).toEqual({ status: Status.PendingReference });
    expect(refund.status).toBe(Status.PendingReference);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("regra 8: reprocessar PENDING_REFERENCE depois que a referência chega aplica a reversão", () => {
    const wallet = newWallet("100.00");
    const refund = newTransaction(Kind.Refund, "30.00", {
      referenceExternalTransactionId: "ext-b",
    });
    apply(refund, wallet);

    const betTx = newTransaction(Kind.Bet, "30.00", { externalTransactionId: "ext-b" });
    apply(betTx, wallet);
    apply(refund, wallet, { reference: betTx });

    expect(refund.status).toBe(Status.Processed);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("referência ainda PENDING ou PENDING_REFERENCE → PENDING_REFERENCE", () => {
    const wallet = newWallet("100.00");
    const pendingBet = newTransaction(Kind.Bet, "30.00");

    const outcome = apply(reversal(Kind.Refund, pendingBet), wallet, { reference: pendingBet });

    expect(outcome.status).toBe(Status.PendingReference);
  });

  test.each([
    ["REJECTED", (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, { at: T0 })],
    ["FAILED", (tx: WagerTransaction) => tx.fail(FailureCode.InfrastructureFailure, T0)],
  ])("referência %s → REJECTED(REFERENCE_NOT_PROCESSED)", (_name, finish) => {
    const wallet = newWallet("100.00");
    const betTx = newTransaction(Kind.Bet, "30.00");
    finish(betTx);

    const outcome = apply(reversal(Kind.Refund, betTx), wallet, { reference: betTx });

    expect(outcome).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test.each([
    ["providerId", { providerId: "provider-b" }],
    ["playerId", { playerId: "player-2" }],
    ["walletId", { walletId: "wallet-2" }],
    ["roundId", { roundId: "round-2" }],
    ["currency", { money: Money.from({ amount: "30.00", currency: "USD" }) }],
  ] as const)("regra 2: referência com %s diferente → REFERENCE_MISMATCH", (_field, override) => {
    const wallet = newWallet("100.00");
    const foreign = newTransaction(Kind.Bet, "30.00", override);
    foreign.markProcessed({
      balanceAfter: Money.from({ amount: "70.00", currency: foreign.money.currency }),
      at: T0,
    });

    const outcome = apply(reversal(Kind.Refund, foreign, "30.00"), wallet, { reference: foreign });

    expect(outcome).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
    });
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("regra 3: REFUND só referencia BET", () => {
    const wallet = newWallet("100.00");
    const win = processed(Kind.Win, "30.00", wallet);

    const outcome = apply(reversal(Kind.Refund, win), wallet, { reference: win });

    expect(outcome).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  test.each([Kind.Loss, Kind.Rollback])("regra 3: ROLLBACK não referencia %s", (kind) => {
    const wallet = newWallet("100.00");
    const betTx = processed(Kind.Bet, "30.00", wallet);
    const reference =
      kind === Kind.Loss ? processed(Kind.Loss, "30.00", wallet) : reversal(Kind.Rollback, betTx);

    const outcome = apply(reversal(Kind.Rollback, reference), wallet, { reference });

    expect(outcome).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  test("WIN que referencia algo que não é BET → INVALID_REFERENCE_KIND", () => {
    const wallet = newWallet("100.00");
    const otherWin = processed(Kind.Win, "10.00", wallet);
    const win = newTransaction(Kind.Win, "10.00", {
      referenceExternalTransactionId: otherWin.externalTransactionId,
    });

    expect(apply(win, wallet, { reference: otherWin })).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  test("regra 4: referência já revertida → REJECTED(ALREADY_REVERSED), sem crédito duplicado", () => {
    const wallet = newWallet("100.00");
    const betTx = processed(Kind.Bet, "30.00", wallet);
    processed(Kind.Refund, "30.00", wallet, betTx);

    const secondRefund = reversal(Kind.Refund, betTx);
    const outcome = apply(secondRefund, wallet, {
      reference: betTx,
      referenceAlreadyReversed: true,
    });

    expect(outcome).toEqual({ status: Status.Rejected, failureCode: FailureCode.AlreadyReversed });
    expect(secondRefund.referenceTransactionId).toBe(betTx.id);
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("regra 4 (interpretação mais estrita): BET refundada não pode ser rollbackada", () => {
    const wallet = newWallet("100.00");
    const betTx = processed(Kind.Bet, "30.00", wallet);
    processed(Kind.Refund, "30.00", wallet, betTx);

    const outcome = apply(reversal(Kind.Rollback, betTx), wallet, {
      reference: betTx,
      referenceAlreadyReversed: true,
    });

    expect(outcome).toEqual({ status: Status.Rejected, failureCode: FailureCode.AlreadyReversed });
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("regra 5: reversão com valor diferente → AMOUNT_MISMATCH (sem reversão parcial)", () => {
    const wallet = newWallet("100.00");
    const betTx = processed(Kind.Bet, "30.00", wallet);

    const outcome = apply(reversal(Kind.Refund, betTx, "10.00"), wallet, { reference: betTx });

    expect(outcome).toEqual({ status: Status.Rejected, failureCode: FailureCode.AmountMismatch });
    expect(wallet.balance.toString()).toBe("70.00");
  });

  test("regras 3 a 5 rejeitam na hora, mesmo com a referência ainda pendente", () => {
    const wallet = newWallet("100.00");
    const pendingBet = newTransaction(Kind.Bet, "30.00");

    const outcome = apply(reversal(Kind.Refund, pendingBet, "10.00"), wallet, {
      reference: pendingBet,
    });

    expect(outcome).toEqual({ status: Status.Rejected, failureCode: FailureCode.AmountMismatch });
  });

  test("regra 9: ROLLBACK de WIN que estouraria o saldo → REVERSAL_WOULD_OVERDRAW", () => {
    const wallet = newWallet("10.00");
    const win = processed(Kind.Win, "50.00", wallet);
    processed(Kind.Bet, "55.00", wallet);
    const rollback = reversal(Kind.Rollback, win);

    const outcome = apply(rollback, wallet, { reference: win });

    expect(outcome).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.ReversalWouldOverdraw,
    });
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(rollback.referenceTransactionId).toBe(win.id);
    expect(wallet.balance.toString()).toBe("5.00");
  });
});

describe("Seção 7: wallet da transação", () => {
  test("player diferente → PLAYER_MISMATCH, sem devolver o saldo da wallet alheia", () => {
    const wallet = newWallet("100.00");
    const tx = newTransaction(Kind.Bet, "10.00", { playerId: "player-2" });

    const outcome = apply(tx, wallet);

    expect(outcome).toEqual({ status: Status.Rejected, failureCode: FailureCode.PlayerMismatch });
    expect(tx.balanceAfter).toBeUndefined();
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("moeda diferente da wallet → CURRENCY_MISMATCH, sem registrar saldo em outra moeda", () => {
    const wallet = newWallet("100.00");
    const tx = newTransaction(Kind.Bet, "10.00", {
      money: Money.from({ amount: "10.00", currency: "USD" }),
    });

    expect(apply(tx, wallet)).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.CurrencyMismatch,
    });
    expect(tx.balanceAfter).toBeUndefined();
    expect(wallet.balance.toString()).toBe("100.00");
  });

  test("transação de outra wallet é erro de programação", () => {
    const wallet = newWallet("100.00");
    const tx = newTransaction(Kind.Bet, "10.00", { walletId: "wallet-2" });

    expect(() => apply(tx, wallet)).toThrow(InvalidWagerApplicationError);
  });

  test("transação já terminal não é reaplicada e o saldo não muda de novo", () => {
    const wallet = newWallet("100.00");
    const tx = newTransaction(Kind.Bet, "10.00");
    apply(tx, wallet);

    expect(() => apply(tx, wallet)).toThrow(InvalidWagerApplicationError);
    expect(wallet.balance.toString()).toBe("90.00");
    expect(wallet.version).toBe(2);
  });
});

describe("Seção 8 (no domínio): 100.00 BRL e duas apostas de 80.00", () => {
  test("exatamente uma PROCESSED, a outra REJECTED, saldo 20.00 e um único débito", () => {
    const wallet = newWallet("100.00");
    const first = newTransaction(Kind.Bet, "80.00");
    const second = newTransaction(Kind.Bet, "80.00");

    // O lock por wallet serializa as duas: a segunda sempre vê o saldo já debitado.
    const outcomes = [apply(first, wallet), apply(second, wallet)];

    expect(outcomes.map((outcome) => outcome.status)).toEqual([Status.Processed, Status.Rejected]);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.toString()).toBe("20.00");
    const debits = outcomes.filter(
      (outcome) => outcome.status === Status.Processed && outcome.ledgerEntry !== undefined,
    );
    expect(debits).toHaveLength(1);
  });
});

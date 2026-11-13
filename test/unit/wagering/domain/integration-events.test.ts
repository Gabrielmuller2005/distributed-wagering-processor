import { describe, expect, test } from "bun:test";
import type { EventContext } from "../../../../src/wagering/domain/events/integration-event";
import { InvalidEventSourceError } from "../../../../src/wagering/domain/events/transaction-event-data";
import { WagerTransactionPendingReference } from "../../../../src/wagering/domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../../../src/wagering/domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../../../src/wagering/domain/events/wager-transaction-rejected";
import {
  LedgerEntryWalletMismatchError,
  WalletBalanceChanged,
} from "../../../../src/wagering/domain/events/wallet-balance-changed";
import { FailureCode } from "../../../../src/wagering/domain/failure-code";
import { WalletLedgerEntry } from "../../../../src/wagering/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../../src/wagering/domain/money";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from "../../../../src/wagering/domain/wager-transaction/wager-transaction";
import { WagerTransactionKind as Kind } from "../../../../src/wagering/domain/wager-transaction/wager-transaction-kind";
import { Wallet } from "../../../../src/wagering/domain/wallet/wallet";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-07-29T15:00:00.000Z");
const T1 = new Date("2026-07-29T15:00:01.000Z");

const context: EventContext = {
  eventId: "event-1",
  correlationId: "corr-1",
  causationId: "msg-123",
  occurredAt: T1,
};

function transaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    payloadHash: "hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: Kind.Bet,
    money: brl("25.00"),
    createdAt: T0,
    ...overrides,
  });
}

/** O que de fato trafega: o JSON serializado (contrato do evento). */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const transactionData = {
  transactionId: "tx-1",
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("IntegrationEvent: envelope", () => {
  test("toJSON produz o envelope do enunciado, com data em JSON puro", () => {
    const tx = transaction();
    tx.markProcessed({ balanceAfter: brl("975.00"), at: T1 });

    expect(wire(WagerTransactionProcessed.from(tx, context))).toEqual({
      eventId: "event-1",
      eventType: "WagerTransactionProcessed",
      aggregateId: "wallet-1",
      correlationId: "corr-1",
      causationId: "msg-123",
      occurredAt: "2026-07-29T15:00:01.000Z",
      version: 1,
      data: {
        ...transactionData,
        referenceTransactionId: null,
        balanceAfter: { amount: "975.00", currency: "BRL" },
        processedAt: "2026-07-29T15:00:01.000Z",
      },
    });
  });

  test("serialização estável: mesma ordem de chaves, byte a byte", () => {
    const tx = transaction();
    tx.markProcessed({ balanceAfter: brl("975.00"), at: T1 });
    const event = WagerTransactionProcessed.from(tx, context);

    const json = JSON.stringify(event);

    expect(json).toBe(JSON.stringify(WagerTransactionProcessed.from(tx, context)));
    expect(Object.keys(JSON.parse(json))).toEqual([
      "eventId",
      "eventType",
      "aggregateId",
      "correlationId",
      "causationId",
      "occurredAt",
      "version",
      "data",
    ]);
  });

  test("causationId é omitido do envelope quando não existe", () => {
    const tx = transaction();
    tx.markProcessed({ balanceAfter: brl("975.00"), at: T1 });
    const { causationId: _omitted, ...withoutCausation } = context;

    const envelope = WagerTransactionProcessed.from(tx, withoutCausation).toJSON();

    expect("causationId" in envelope).toBe(false);
  });

  test("data é congelado em profundidade e não contém instâncias de Money", () => {
    const tx = transaction();
    tx.markProcessed({ balanceAfter: brl("975.00"), at: T1 });
    const event = WagerTransactionProcessed.from(tx, context);

    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(event.data.money).not.toBeInstanceOf(Money);
    expect(typeof event.data.money.amount).toBe("string");
  });

  test("alterar a Date do contexto não altera o evento", () => {
    const occurredAt = new Date(T1.getTime());
    const tx = transaction();
    tx.markProcessed({ balanceAfter: brl("975.00"), at: T1 });
    const event = WagerTransactionProcessed.from(tx, { ...context, occurredAt });

    occurredAt.setFullYear(1999);

    expect(event.toJSON().occurredAt).toBe("2026-07-29T15:00:01.000Z");
  });
});

describe("WagerTransactionProcessed", () => {
  test("inclui LOSS (aplicada sem mover saldo)", () => {
    const tx = transaction({ kind: Kind.Loss, money: Money.zero("BRL") });
    tx.markProcessed({ balanceAfter: brl("100.00"), at: T1 });

    expect(WagerTransactionProcessed.from(tx, context).data.kind).toBe(Kind.Loss);
  });

  test("leva a referência resolvida", () => {
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markProcessed({ referenceTransactionId: "tx-0", balanceAfter: brl("100.00"), at: T1 });

    expect(WagerTransactionProcessed.from(tx, context).data.referenceTransactionId).toBe("tx-0");
  });

  test("exige transação PROCESSED", () => {
    expect(() => WagerTransactionProcessed.from(transaction(), context)).toThrow(
      InvalidEventSourceError,
    );
  });
});

describe("WagerTransactionRejected", () => {
  test("leva o código, a categoria e o saldo observado", () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds, { balanceAfter: brl("10.00"), at: T1 });

    const event = WagerTransactionRejected.from(tx, context);

    expect(event.eventType).toBe("WagerTransactionRejected");
    expect(wire(event.data)).toEqual({
      ...transactionData,
      failureCode: "INSUFFICIENT_FUNDS",
      failureCategory: "FINAL",
      referenceTransactionId: null,
      balanceAfter: { amount: "10.00", currency: "BRL" },
      rejectedAt: "2026-07-29T15:00:01.000Z",
    });
  });

  test("saldo null quando não pode ser exposto (PLAYER_MISMATCH)", () => {
    const tx = transaction();
    tx.reject(FailureCode.PlayerMismatch, { at: T1 });

    expect(WagerTransactionRejected.from(tx, context).data.balanceAfter).toBeNull();
  });

  test("exige transação REJECTED", () => {
    const tx = transaction();
    tx.markProcessed({ balanceAfter: brl("1.00"), at: T1 });

    expect(() => WagerTransactionRejected.from(tx, context)).toThrow(InvalidEventSourceError);
  });
});

describe("WagerTransactionPendingReference", () => {
  test("leva o id externo da referência que falta", () => {
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: "bet-missing" });
    tx.markPendingReference();

    const event = WagerTransactionPendingReference.from(tx, context);

    expect(event.eventType).toBe("WagerTransactionPendingReference");
    expect(event.data.referenceExternalTransactionId).toBe("bet-missing");
    expect(event.aggregateId).toBe("wallet-1");
  });

  test("exige transação PENDING_REFERENCE", () => {
    expect(() => WagerTransactionPendingReference.from(transaction(), context)).toThrow(
      InvalidEventSourceError,
    );
  });
});

describe("WalletBalanceChanged", () => {
  test("é construído a partir do lançamento e leva a versão da wallet", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("1000.00"),
      at: T0,
    });
    const movement = wallet.debit(brl("25.00"), T1);
    const entry = WalletLedgerEntry.create({
      ...movement,
      id: "entry-1",
      walletId: wallet.id,
      transactionId: "tx-1",
      createdAt: T1,
    });

    const event = WalletBalanceChanged.from(wallet, entry, context);

    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe("wallet-1");
    expect(wire(event.data)).toEqual({
      walletId: "wallet-1",
      transactionId: "tx-1",
      ledgerEntryId: "entry-1",
      direction: "DEBIT",
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "1000.00", currency: "BRL" },
      balanceAfter: { amount: "975.00", currency: "BRL" },
      walletVersion: 2,
    });
  });

  test("rejeita lançamento de outra wallet", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("100.00"),
      at: T0,
    });
    const entry = WalletLedgerEntry.create({
      ...wallet.debit(brl("1.00"), T1),
      id: "entry-1",
      walletId: "wallet-2",
      transactionId: "tx-1",
      createdAt: T1,
    });

    expect(() => WalletBalanceChanged.from(wallet, entry, context)).toThrow(
      LedgerEntryWalletMismatchError,
    );
  });
});

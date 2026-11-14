import { FailureCode } from "../../domain/failure-code";
import { LedgerDirection } from "../../domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money";
import { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { WagerTransactionKind } from "../../domain/wager-transaction/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wager-transaction/wager-transaction-status";
import { Wallet } from "../../domain/wallet/wallet";
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records";

/**
 * Conversão registro ↔ domínio. A leitura usa sempre `rehydrate` (não revalida transições);
 * dinheiro volta do banco como string e vira Money com a moeda da coluna ao lado.
 */

/** Valor lido do banco fora do esperado: indica dado corrompido, nunca deve ser ignorado. */
export class PersistenceMappingError extends Error {
  constructor(table: string, field: string, value: unknown) {
    super(`Unexpected value in ${table}.${field}: ${JSON.stringify(value)}`);
    this.name = "PersistenceMappingError";
  }
}

function parseEnum<E extends Record<string, string>>(
  enumObject: E,
  value: string,
  table: string,
  field: string,
): E[keyof E] {
  const match = Object.values(enumObject).find((candidate) => candidate === value);
  if (match === undefined) throw new PersistenceMappingError(table, field, value);
  return match as E[keyof E];
}

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });
const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

// ---- Wallet

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function fromWallet(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

// ---- WagerTransaction

const TX_TABLE = "wager_transactions";

export function toWagerTransaction(record: WagerTransactionRecord): WagerTransaction {
  const failureCode = orUndefined(record.failureCode);
  const balanceAfter = orUndefined(record.balanceAfter);

  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: parseEnum(WagerTransactionKind, record.kind, TX_TABLE, "kind"),
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: parseEnum(WagerTransactionStatus, record.status, TX_TABLE, "status"),
    referenceTransactionId: orUndefined(record.referenceTransactionId),
    failureCode:
      failureCode === undefined
        ? undefined
        : parseEnum(FailureCode, failureCode, TX_TABLE, "failure_code"),
    processedAt: orUndefined(record.processedAt),
    balanceAfter: balanceAfter === undefined ? undefined : money(balanceAfter, record.currency),
  });
}

/** Colunas que mudam quando a transação termina (as demais são imutáveis no banco). */
export function resultColumns(transaction: WagerTransaction) {
  return {
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balanceAfter: transaction.balanceAfter?.toString() ?? null,
    processedAt: transaction.processedAt ?? null,
  };
}

export function fromWagerTransaction(transaction: WagerTransaction): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toString(),
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    ...resultColumns(transaction),
    referenceAttempts: 0,
    nextReferenceAttemptAt: null,
    createdAt: transaction.createdAt,
    updatedAt: transaction.createdAt,
  };
}

// ---- Ledger

export function toLedgerEntry(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    walletVersion: record.walletVersion,
    direction: parseEnum(LedgerDirection, record.direction, "wallet_ledger_entries", "direction"),
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    createdAt: record.createdAt,
  });
}

export function fromLedgerEntry(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt,
  };
}

// ---- Inbox

export function toInboxMessage(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: record.messageId,
    consumerName: record.consumerName,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: orUndefined(record.processedAt),
  });
}

export function fromInboxMessage(message: InboxMessage): InboxMessageRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

// ---- Outbox

export function toOutboxMessage(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    publishedAt: orUndefined(record.publishedAt),
    lastError: orUndefined(record.lastError),
  });
}

/** Colunas que mudam a cada tentativa de publicação. */
export function deliveryColumns(message: OutboxMessage) {
  return {
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt ?? null,
    lastError: message.lastError ?? null,
  };
}

export function fromOutboxMessage(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    ...deliveryColumns(message),
  };
}

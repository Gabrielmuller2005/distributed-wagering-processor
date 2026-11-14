import { defineEntity, type InferEntity, p } from "@mikro-orm/core";

/**
 * Registros de persistência: o formato das linhas no banco, sem regra de negócio.
 * Ficam fora do domínio; os mappers convertem registro ↔ domínio usando `rehydrate`.
 *
 * Dinheiro: `p.decimal()` lê e grava numeric como **string** (nunca float), e a moeda fica em
 * coluna separada. O schema real é o das migrations (SQL escrito à mão); estas definições só
 * descrevem as colunas para o ORM.
 */

export const WalletRecord = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.string(),
    currency: p.string().length(3),
    balance: p.decimal().precision(19).scale(2),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WalletRecord = InferEntity<typeof WalletRecord>;

export const WagerTransactionRecord = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string().length(64),
    walletId: p.uuid(),
    playerId: p.string(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.string(),
    amount: p.decimal().precision(19).scale(2),
    currency: p.string().length(3),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    balanceAfter: p.decimal().precision(19).scale(2).nullable(),
    processedAt: p.datetime().nullable(),
    referenceAttempts: p.integer(),
    nextReferenceAttemptAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;

export const LedgerEntryRecord = defineEntity({
  name: "LedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    walletVersion: p.integer(),
    direction: p.string(),
    amount: p.decimal().precision(19).scale(2),
    currency: p.string().length(3),
    balanceBefore: p.decimal().precision(19).scale(2),
    balanceAfter: p.decimal().precision(19).scale(2),
    createdAt: p.datetime(),
  },
});
export type LedgerEntryRecord = InferEntity<typeof LedgerEntryRecord>;

export const InboxMessageRecord = defineEntity({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.string().primary(),
    messageId: p.string().primary(),
    payloadHash: p.string().length(64),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type InboxMessageRecord = InferEntity<typeof InboxMessageRecord>;

export const OutboxMessageRecord = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.string(),
    eventType: p.string(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    publishedAt: p.datetime().nullable(),
    lastError: p.text().nullable(),
  },
});
export type OutboxMessageRecord = InferEntity<typeof OutboxMessageRecord>;

export const PERSISTENCE_ENTITIES = [
  WalletRecord,
  WagerTransactionRecord,
  LedgerEntryRecord,
  InboxMessageRecord,
  OutboxMessageRecord,
];

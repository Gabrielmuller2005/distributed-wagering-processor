import { LockMode, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ConcurrentModificationError, WalletAlreadyExistsError } from "../../application/errors";
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  TransactionalRepositories,
  WagerTransactionRepository,
  WalletRepository,
} from "../../application/ports/repositories";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money";
import type { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { WagerTransactionKind } from "../../domain/wager-transaction/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wager-transaction/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";
import {
  deliveryColumns,
  fromInboxMessage,
  fromLedgerEntry,
  fromOutboxMessage,
  fromWagerTransaction,
  fromWallet,
  resultColumns,
  toInboxMessage,
  toLedgerEntry,
  toOutboxMessage,
  toWagerTransaction,
  toWallet,
} from "./mappers";
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records";

/**
 * Adapters MikroORM das ports de persistência.
 *
 * - Leituras usam `disableIdentityMap`: cada leitura vai ao banco e devolve dados frescos.
 *   O estado vive no domínio, não em entidades gerenciadas pelo ORM.
 * - Escritas são explícitas (`insert`, `nativeUpdate`, `ON CONFLICT DO NOTHING`), sem flush
 *   automático: cada SQL que mexe em dinheiro é visível aqui.
 */
const FRESH = { disableIdentityMap: true } as const;

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id }, FRESH);
    return record ? toWallet(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? toWallet(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, fromWallet(wallet));
    } catch (error: unknown) {
      if (
        error instanceof UniqueConstraintViolationException &&
        error.message.includes("wallets_player_currency_unique")
      ) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.toString(),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (affected !== 1) throw new ConcurrentModificationError("Wallet", wallet.id);
  }
}

const REVERSAL_KINDS = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { id }, FRESH);
    return record ? toWagerTransaction(record) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { idempotencyKey }, FRESH);
    return record ? toWagerTransaction(record) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      FRESH,
    );
    return record ? toWagerTransaction(record) : undefined;
  }

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    // Sem alvo no ON CONFLICT: cobre as duas unicidades (idempotency key e provider + id externo).
    const result = await this.em
      .createQueryBuilder(WagerTransactionRecord)
      .insert(fromWagerTransaction(transaction))
      .onConflict()
      .ignore()
      .execute("run");
    return result.affectedRows === 1;
  }

  async saveResult(transaction: WagerTransaction): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      { ...resultColumns(transaction), updatedAt: transaction.processedAt ?? new Date() },
    );
    if (affected !== 1) throw new ConcurrentModificationError("WagerTransaction", transaction.id);
  }

  async scheduleReferenceRetry(
    transactionId: string,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transactionId, status: WagerTransactionStatus.PendingReference },
      { referenceAttempts: attempts, nextReferenceAttemptAt: nextAttemptAt, updatedAt: new Date() },
    );
    if (affected !== 1) throw new ConcurrentModificationError("WagerTransaction", transactionId);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: REVERSAL_KINDS },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }
}

interface LedgerTotalsRow {
  readonly credits: string;
  readonly debits: string;
  readonly entries: number;
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, fromLedgerEntry(entry));
  }

  async listByWallet(
    walletId: string,
    options: { readonly afterVersion?: number | undefined; readonly limit: number },
  ): Promise<LedgerPage> {
    // Busca um a mais que o limite para saber se existe próxima página.
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: options.afterVersion ?? 0 } },
      { ...FRESH, orderBy: { walletVersion: "asc" }, limit: options.limit + 1 },
    );
    const page = records.slice(0, options.limit).map(toLedgerEntry);
    const hasMore = records.length > options.limit;
    return {
      entries: page,
      nextAfterVersion: hasMore ? page[page.length - 1]?.walletVersion : undefined,
    };
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    // Somas calculadas pelo banco, em numeric (exato), e lidas como texto.
    const [row] = await this.em.execute<LedgerTotalsRow[]>(
      `select
         coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::text as credits,
         coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::text as debits,
         count(*)::int as entries
       from wallet_ledger_entries
       where wallet_id = ?`,
      [walletId],
    );
    return {
      credits: Money.from({ amount: row?.credits ?? "0", currency }),
      debits: Money.from({ amount: row?.debits ?? "0", currency }),
      entries: row?.entries ?? 0,
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, FRESH);
    return record ? toInboxMessage(record) : undefined;
  }

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(InboxMessageRecord)
      .insert(fromInboxMessage(message))
      .onConflict(["consumerName", "messageId"])
      .ignore()
      .execute("run");
    return result.affectedRows === 1;
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map(fromOutboxMessage));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        ...FRESH,
        orderBy: { nextAttemptAt: "asc" },
        limit,
        // FOR UPDATE SKIP LOCKED: linhas já travadas por outro publisher são puladas.
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return records.map(toOutboxMessage);
  }

  async save(message: OutboxMessage): Promise<void> {
    const affected = await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      deliveryColumns(message),
    );
    if (affected !== 1) throw new ConcurrentModificationError("OutboxMessage", message.id);
  }
}

export function createRepositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

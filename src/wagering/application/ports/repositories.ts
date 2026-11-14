import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Money } from "../../domain/money";
import type { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";

/**
 * Ports de persistência. A aplicação depende só destas interfaces; os adapters (MikroORM)
 * ficam na infraestrutura. Todas as operações rodam dentro da transação aberta pelo UnitOfWork.
 */

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** Lê a wallet com `SELECT ... FOR UPDATE`: segura o lock da linha até o fim da transação. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /** Lança WalletAlreadyExistsError se já houver wallet para o player e a moeda. */
  insert(wallet: Wallet): Promise<void>;
  /**
   * Grava saldo e versão com `UPDATE ... WHERE id = :id AND version = :expectedVersion`.
   * Lança ConcurrentModificationError se a versão no banco não for a esperada.
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /**
   * `INSERT ... ON CONFLICT DO NOTHING`. Devolve false se já existir transação com a mesma
   * idempotency key ou o mesmo (provider, id externo): quem chama relê e decide replay/conflito.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  /** Grava o resultado (status, código, referência, saldo observado, horário). */
  saveResult(transaction: WagerTransaction): Promise<void>;
  /**
   * Agenda a próxima tentativa de resolver a referência de uma transação PENDING_REFERENCE
   * (usado pelo worker de reprocessamento, com backoff).
   */
  scheduleReferenceRetry(
    transactionId: string,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<void>;
  /**
   * Reserva até `limit` transações PENDING_REFERENCE vencidas (`FOR UPDATE SKIP LOCKED`) e
   * empurra a próxima tentativa delas para `leaseUntil`, para outro worker não pegá-las enquanto
   * esta instância as reprocessa. Se o worker morrer, a reserva vence e outro assume.
   */
  claimDueReferenceRetries(
    now: Date,
    limit: number,
    leaseUntil: Date,
  ): Promise<DueReferenceRetry[]>;
  /**
   * A transação (provider, id externo) acabou de terminar: as PENDING_REFERENCE que apontam para
   * ela ficam vencidas na hora, em vez de esperar o próximo intervalo do backoff.
   */
  expediteReferenceRetries(
    providerId: string,
    referenceExternalTransactionId: string,
    now: Date,
  ): Promise<number>;
  /** Se a transação já tem um REFUND ou ROLLBACK PROCESSED apontando para ela. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
}

export interface DueReferenceRetry {
  readonly transactionId: string;
  readonly walletId: string;
  /** Novas tentativas já feitas pelo worker (0 = só a tentativa da submissão). */
  readonly attempts: number;
}

export interface LedgerPage {
  readonly entries: readonly WalletLedgerEntry[];
  /** Última versão da página; undefined quando não há mais lançamentos. */
  readonly nextAfterVersion: number | undefined;
}

export interface LedgerTotals {
  readonly credits: Money;
  readonly debits: Money;
  readonly entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Lançamentos em ordem de versão da wallet, a partir de `afterVersion` (exclusivo). */
  listByWallet(
    walletId: string,
    options: { readonly afterVersion?: number | undefined; readonly limit: number },
  ): Promise<LedgerPage>;
  /** Soma de créditos e débitos calculada pelo banco, para a reconciliação. */
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /** `INSERT ... ON CONFLICT DO NOTHING`. Devolve false se a mensagem já foi registrada. */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
}

export interface OutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  /**
   * Mensagens pendentes e vencidas, travadas com `FOR UPDATE SKIP LOCKED`: vários publishers
   * em paralelo pegam lotes diferentes, sem esperar uns pelos outros.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /**
   * Grava o estado de entrega (reserva, publicada ou retry agendado). Só altera mensagem ainda
   * pendente no banco: devolve false se outro publisher já a marcou como publicada.
   */
  save(message: OutboxMessage): Promise<boolean>;
}

export interface TransactionalRepositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

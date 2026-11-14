import type { Clock } from "../../../shared/application/clock";
import type { IdGenerator } from "../../../shared/application/id-generator";
import { backoffDelayMs } from "../../../shared/domain/backoff";
import { FailureCode } from "../../domain/failure-code";
import { WagerTransactionStatus } from "../../domain/wager-transaction/wager-transaction-status";
import { applyAndRecord } from "../apply-and-record";
import { outcomeOutboxMessages } from "../outcome-events";
import { PENDING_REFERENCE_RETRY_POLICY } from "../pending-reference-policy";
import type { DueReferenceRetry } from "../ports/repositories";
import type { UnitOfWork } from "../ports/unit-of-work";

export interface PendingReferenceOptions {
  /** Transações reservadas por ciclo. */
  readonly batchSize: number;
  /**
   * Prazo para a referência chegar, contado da aceitação da transação. Esgotado sem referência,
   * a transação é rejeitada com REFERENCE_NOT_FOUND.
   */
  readonly ttlMs: number;
  /** Duração da reserva de um lote: outro worker só assume depois disso. */
  readonly leaseMs: number;
}

export type ReferenceRetryOutcome =
  /** A referência chegou: PROCESSED ou REJECTED por regra (ex.: valor divergente). */
  | "RESOLVED"
  /** O prazo acabou sem referência: REJECTED(REFERENCE_NOT_FOUND). */
  | "EXPIRED"
  /** Continua esperando; próxima tentativa agendada com backoff. */
  | "RESCHEDULED"
  /** Já não estava pendente (outro worker ou uma reentrega resolveu antes). */
  | "SKIPPED"
  /** A tentativa falhou (ex.: lock timeout); a reserva vence e a transação volta a ser tentada. */
  | "FAILED";

export interface RetryPendingReferencesResult {
  readonly claimed: number;
  readonly outcomes: Readonly<Record<ReferenceRetryOutcome, number>>;
  /** Primeira falha do ciclo, para o worker logar. */
  readonly firstError?: unknown;
}

/**
 * Reprocessa transações PENDING_REFERENCE vencidas (REFUND, ROLLBACK, WIN ou LOSS que chegaram
 * antes da transação referenciada).
 *
 * 1. Reserva um lote com `FOR UPDATE SKIP LOCKED` numa transação curta: vários workers em
 *    paralelo pegam lotes disjuntos.
 * 2. Cada transação é reprocessada na **sua própria** transação SQL, com as mesmas regras e o
 *    mesmo lock da submissão: primeiro a wallet (`FOR UPDATE`), depois a transação, relida.
 *    A ordem dos locks é a mesma do caso de uso de submissão, então não há deadlock entre os dois.
 * 3. O desfecho grava resultado e eventos na mesma transação SQL:
 *    - referência resolvida: PROCESSED (com lançamento) ou REJECTED por regra, com os eventos;
 *    - prazo esgotado: REJECTED(REFERENCE_NOT_FOUND) e o evento `WagerTransactionRejected`;
 *    - ainda dentro do prazo: nova tentativa com backoff, sem evento novo (o
 *      `WagerTransactionPendingReference` já saiu na submissão).
 *
 * A falha de uma transação não interrompe as outras do lote.
 */
export class RetryPendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly options: PendingReferenceOptions,
    private readonly random: () => number = Math.random,
  ) {}

  async execute(): Promise<RetryPendingReferencesResult> {
    const due = await this.unitOfWork.run(({ transactions }) => {
      const now = this.clock.now();
      return transactions.claimDueReferenceRetries(
        now,
        this.options.batchSize,
        new Date(now.getTime() + this.options.leaseMs),
      );
    });

    const outcomes: Record<ReferenceRetryOutcome, number> = {
      RESOLVED: 0,
      EXPIRED: 0,
      RESCHEDULED: 0,
      SKIPPED: 0,
      FAILED: 0,
    };
    let firstError: unknown;
    for (const item of due) {
      try {
        outcomes[await this.retry(item)] += 1;
      } catch (error: unknown) {
        outcomes.FAILED += 1;
        firstError ??= error;
      }
    }
    return { claimed: due.length, outcomes, ...(firstError ? { firstError } : {}) };
  }

  private retry(item: DueReferenceRetry): Promise<ReferenceRetryOutcome> {
    return this.unitOfWork.run(async (repositories) => {
      const at = this.clock.now();
      const wallet = await repositories.wallets.findByIdForUpdate(item.walletId);
      const transaction = await repositories.transactions.findById(item.transactionId);
      if (!wallet || transaction?.status !== WagerTransactionStatus.PendingReference) {
        return "SKIPPED";
      }

      const { outcome, ledgerEntry } = await applyAndRecord({
        repositories,
        transaction,
        wallet,
        ledgerEntryId: this.ids.next(),
        at,
      });

      let result: ReferenceRetryOutcome;
      if (outcome.status !== WagerTransactionStatus.PendingReference) {
        result = "RESOLVED";
      } else if (at.getTime() - transaction.createdAt.getTime() >= this.options.ttlMs) {
        // Rejeitada com o saldo da wallet no momento, como as demais rejeições de negócio.
        transaction.reject(FailureCode.ReferenceNotFound, { balanceAfter: wallet.balance, at });
        result = "EXPIRED";
      } else {
        const attempts = item.attempts + 1;
        const delay = backoffDelayMs(attempts + 1, PENDING_REFERENCE_RETRY_POLICY, this.random);
        await repositories.transactions.scheduleReferenceRetry(
          transaction.id,
          attempts,
          new Date(at.getTime() + delay),
        );
        return "RESCHEDULED";
      }

      await repositories.transactions.saveResult(transaction);
      await repositories.outbox.add(
        outcomeOutboxMessages({
          transaction,
          wallet,
          ledgerEntry,
          // A transação original não guarda o correlationId da requisição; o id da transação
          // correlaciona todos os eventos dela (o PendingReference da submissão inclusive, pelo
          // transactionId do payload).
          metadata: { correlationId: transaction.id },
          ids: this.ids,
          at,
        }),
      );
      return result;
    });
  }
}

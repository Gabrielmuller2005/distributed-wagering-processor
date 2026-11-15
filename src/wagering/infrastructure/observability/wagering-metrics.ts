import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export const WAGERING_METRICS = Symbol("WAGERING_METRICS");

/** Por onde a transação entrou. */
export type Channel = "http" | "sqs" | "worker";

/** Componentes que agendam novas tentativas. */
export type RetryComponent = "sqs_consumer" | "outbox_publisher" | "pending_reference";

/** Estado das filas internas, lido do banco no momento do scrape. */
export interface BacklogSnapshot {
  readonly outboxPending: number;
  /** Idade da mensagem pendente mais antiga da outbox, em segundos (0 sem pendências). */
  readonly outboxOldestAgeSeconds: number;
  readonly pendingReferences: number;
}

export type BacklogProbe = () => Promise<BacklogSnapshot>;

/** Motivos transitórios que são, de fato, disputa de lock ou de versão. */
const LOCK_CONFLICT_REASONS = new Set([
  "LOCK_TIMEOUT",
  "DEADLOCK",
  "SERIALIZATION_FAILURE",
  "CONCURRENT_MODIFICATION",
]);

/** Limite de cardinalidade: só o código antes do primeiro ":" ou espaço vira label. */
function reasonCode(reason: string): string {
  const code = reason.split(/[:\s(]/, 1)[0] ?? "";
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "OTHER";
}

/**
 * Métricas Prometheus do serviço, num registry **por instância** (não o global do prom-client):
 * várias aplicações no mesmo processo, como nos testes, não colidem.
 *
 * Cobertura mínima do enunciado (seção 12):
 * - transações por status: `wagering_transactions_total{channel,status,replay}`;
 * - duplicatas detectadas: `wagering_duplicates_total{channel}`;
 * - retries: `wagering_retries_total{component,reason}`;
 * - mensagens em DLQ: `wagering_dead_letter_messages_total{reason}`;
 * - conflitos de lock: `wagering_lock_conflicts_total{channel,reason}`;
 * - outbox lag: `wagering_outbox_lag_seconds` (idade da pendente mais antiga, lida no scrape);
 * - latência de processamento: `wagering_processing_duration_seconds{channel,outcome}`.
 */
export class WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Wager transaction submissions by entry channel, resulting status and replay flag",
    labelNames: ["channel", "status", "replay"] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: "wagering_duplicates_total",
    help: "Duplicate submissions detected (idempotency key or inbox), answered as replay",
    labelNames: ["channel"] as const,
    registers: [this.registry],
  });

  private readonly processingDuration = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "Time to process a wager transaction submission, by channel and outcome",
    labelNames: ["channel", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Retries scheduled, by component and reason",
    labelNames: ["component", "reason"] as const,
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: "wagering_dead_letter_messages_total",
    help: "Messages sent to the dead-letter queue, by reason",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Lock and version conflicts (lock timeout 55P03, deadlock 40P01, serialization 40001, version mismatch)",
    labelNames: ["channel", "reason"] as const,
    registers: [this.registry],
  });

  private readonly outboxPublished = new Counter({
    name: "wagering_outbox_published_total",
    help: "Outbox messages confirmed by the broker",
    registers: [this.registry],
  });

  private readonly pendingReferenceOutcomes = new Counter({
    name: "wagering_pending_reference_outcomes_total",
    help: "Pending reference retries by outcome (RESOLVED, EXPIRED, RESCHEDULED, SKIPPED, FAILED)",
    labelNames: ["outcome"] as const,
    registers: [this.registry],
  });

  private readonly reconciliationInconsistencies = new Counter({
    name: "wagering_reconciliation_inconsistencies_total",
    help: "Reconciliations where the stored balance differs from the ledger",
    registers: [this.registry],
  });

  constructor(probe?: BacklogProbe, onProbeError?: (error: unknown) => void) {
    collectDefaultMetrics({ register: this.registry });
    if (probe) this.registerBacklogGauges(probe, onProbeError);
  }

  /** Resultado de uma submissão (HTTP, SQS) concluída pelo caso de uso. */
  transactionCompleted(
    channel: Channel,
    result: { readonly status: string; readonly idempotentReplay: boolean },
    durationSeconds: number,
  ): void {
    this.transactions.inc({
      channel,
      status: result.status,
      replay: String(result.idempotentReplay),
    });
    if (result.idempotentReplay) this.duplicates.inc({ channel });
    this.processingDuration.observe({ channel, outcome: result.status }, durationSeconds);
  }

  /** Submissão que terminou em erro (validação, conflito, transitório...). */
  transactionFailed(channel: Channel, code: string, durationSeconds: number): void {
    this.processingDuration.observe({ channel, outcome: reasonCode(code) }, durationSeconds);
  }

  /** Falha transitória classificada; conta como conflito de lock quando for o caso. */
  transientFailure(channel: Channel, reason: string): void {
    if (LOCK_CONFLICT_REASONS.has(reason)) this.lockConflicts.inc({ channel, reason });
  }

  retryScheduled(component: RetryComponent, reason: string, count = 1): void {
    if (count > 0) this.retries.inc({ component, reason: reasonCode(reason) }, count);
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason: reasonCode(reason) });
  }

  outboxMessagesPublished(count: number): void {
    if (count > 0) this.outboxPublished.inc(count);
  }

  pendingReferenceOutcome(outcome: string, count: number): void {
    if (count > 0) this.pendingReferenceOutcomes.inc({ outcome }, count);
  }

  reconciliationInconsistent(): void {
    this.reconciliationInconsistencies.inc();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Gauges lidos do banco a cada scrape (uma consulta para os três). Se o banco estiver fora,
   * os gauges mantêm o último valor e o erro é reportado; o /metrics continua respondendo.
   */
  private registerBacklogGauges(probe: BacklogProbe, onError?: (error: unknown) => void): void {
    let snapshot: Promise<BacklogSnapshot | undefined> | undefined;
    // O scrape dispara a coleta dos três gauges de uma vez, antes de qualquer resposta: a
    // primeira chamada abre a consulta e as outras duas reaproveitam a mesma promessa.
    const read = () => {
      snapshot ??= probe()
        .catch((error: unknown) => {
          onError?.(error);
          return undefined;
        })
        .finally(() => {
          snapshot = undefined;
        });
      return snapshot;
    };

    const registry = this.registry;
    new Gauge({
      name: "wagering_outbox_lag_seconds",
      help: "Age in seconds of the oldest outbox message not yet published (0 when none)",
      registers: [registry],
      async collect() {
        const value = await read();
        if (value) this.set(value.outboxOldestAgeSeconds);
      },
    });
    new Gauge({
      name: "wagering_outbox_pending_messages",
      help: "Outbox messages not yet published",
      registers: [registry],
      async collect() {
        const value = await read();
        if (value) this.set(value.outboxPending);
      },
    });
    new Gauge({
      name: "wagering_pending_reference_transactions",
      help: "Transactions waiting for their reference (PENDING_REFERENCE)",
      registers: [registry],
      async collect() {
        const value = await read();
        if (value) this.set(value.pendingReferences);
      },
    });
  }
}

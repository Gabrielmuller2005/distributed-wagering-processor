import { describe, expect, test } from "bun:test";
import {
  type BacklogSnapshot,
  WageringMetrics,
} from "../../../../src/wagering/infrastructure/observability/wagering-metrics";

/** Valor de uma série no formato texto do Prometheus (sem labels ou com o trecho de labels dado). */
function seriesValue(text: string, metric: string, labels = ""): number | undefined {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(labels ? `${metric}{${labels}}` : `${metric} `));
  if (!line) return undefined;
  const raw = line.slice(line.lastIndexOf(" ") + 1);
  return Number.parseFloat(raw);
}

describe("WageringMetrics", () => {
  test("transações por status, com replay contado também como duplicata", async () => {
    const metrics = new WageringMetrics();

    metrics.transactionCompleted("http", { status: "PROCESSED", idempotentReplay: false }, 0.01);
    metrics.transactionCompleted("http", { status: "PROCESSED", idempotentReplay: true }, 0.002);
    metrics.transactionCompleted("sqs", { status: "REJECTED", idempotentReplay: false }, 0.02);
    const text = await metrics.render();

    expect(
      seriesValue(
        text,
        "wagering_transactions_total",
        'channel="http",status="PROCESSED",replay="false"',
      ),
    ).toBe(1);
    expect(
      seriesValue(
        text,
        "wagering_transactions_total",
        'channel="http",status="PROCESSED",replay="true"',
      ),
    ).toBe(1);
    expect(
      seriesValue(
        text,
        "wagering_transactions_total",
        'channel="sqs",status="REJECTED",replay="false"',
      ),
    ).toBe(1);
    expect(seriesValue(text, "wagering_duplicates_total", 'channel="http"')).toBe(1);
    expect(
      seriesValue(
        text,
        "wagering_processing_duration_seconds_count",
        'channel="http",outcome="PROCESSED"',
      ),
    ).toBe(2);
  });

  test("conflitos de lock contam só disputa de lock ou versão, não banco fora", async () => {
    const metrics = new WageringMetrics();

    metrics.transientFailure("http", "LOCK_TIMEOUT");
    metrics.transientFailure("sqs", "DEADLOCK");
    metrics.transientFailure("http", "DATABASE_UNAVAILABLE");
    const text = await metrics.render();

    expect(
      seriesValue(text, "wagering_lock_conflicts_total", 'channel="http",reason="LOCK_TIMEOUT"'),
    ).toBe(1);
    expect(
      seriesValue(text, "wagering_lock_conflicts_total", 'channel="sqs",reason="DEADLOCK"'),
    ).toBe(1);
    expect(text).not.toContain('reason="DATABASE_UNAVAILABLE"');
  });

  test("motivos de retry e DLQ viram só o código: cardinalidade limitada", async () => {
    const metrics = new WageringMetrics();

    metrics.deadLettered("VALIDATION_ERROR: INVALID_AMOUNT (money)");
    metrics.deadLettered("INVALID_ENVELOPE: body is not valid JSON");
    metrics.deadLettered("free text with wallet 0192f2");
    metrics.retryScheduled("sqs_consumer", "LOCK_TIMEOUT");
    metrics.retryScheduled("outbox_publisher", "PUBLISH_FAILED", 3);
    metrics.retryScheduled("pending_reference", "REFERENCE_MISSING", 0);
    const text = await metrics.render();

    expect(
      seriesValue(text, "wagering_dead_letter_messages_total", 'reason="VALIDATION_ERROR"'),
    ).toBe(1);
    expect(
      seriesValue(text, "wagering_dead_letter_messages_total", 'reason="INVALID_ENVELOPE"'),
    ).toBe(1);
    expect(seriesValue(text, "wagering_dead_letter_messages_total", 'reason="OTHER"')).toBe(1);
    expect(
      seriesValue(
        text,
        "wagering_retries_total",
        'component="outbox_publisher",reason="PUBLISH_FAILED"',
      ),
    ).toBe(3);
    expect(text).not.toContain('component="pending_reference"');
    expect(text).not.toContain("0192f2");
  });

  test("outbox lag e backlog são lidos da sonda a cada scrape, com uma consulta só", async () => {
    let calls = 0;
    let snapshot: BacklogSnapshot = {
      outboxPending: 3,
      outboxOldestAgeSeconds: 12.5,
      pendingReferences: 2,
    };
    const metrics = new WageringMetrics(async () => {
      calls += 1;
      return snapshot;
    });

    const first = await metrics.render();
    snapshot = { outboxPending: 0, outboxOldestAgeSeconds: 0, pendingReferences: 0 };
    const second = await metrics.render();

    expect(seriesValue(first, "wagering_outbox_lag_seconds")).toBe(12.5);
    expect(seriesValue(first, "wagering_outbox_pending_messages")).toBe(3);
    expect(seriesValue(first, "wagering_pending_reference_transactions")).toBe(2);
    expect(seriesValue(second, "wagering_outbox_lag_seconds")).toBe(0);
    expect(calls).toBe(2);
  });

  test("sonda falhando não derruba o /metrics: o erro é reportado e o resto sai", async () => {
    const errors: unknown[] = [];
    const metrics = new WageringMetrics(
      async () => {
        throw new Error("database down");
      },
      (error) => errors.push(error),
    );
    metrics.outboxMessagesPublished(2);

    const text = await metrics.render();

    expect(seriesValue(text, "wagering_outbox_published_total")).toBe(2);
    expect(errors).toHaveLength(1);
  });

  test("cada instância tem o seu registry: duas aplicações no mesmo processo não colidem", async () => {
    const a = new WageringMetrics();
    const b = new WageringMetrics();

    a.reconciliationInconsistent();

    expect(seriesValue(await a.render(), "wagering_reconciliation_inconsistencies_total")).toBe(1);
    expect(seriesValue(await b.render(), "wagering_reconciliation_inconsistencies_total")).toBe(0);
    expect(await a.render()).toContain("process_cpu_user_seconds_total");
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@aws-sdk/client-sqs";
import type { Clock } from "../../../src/shared/application/clock";
import type {
  EventPublisher,
  PublishBatchResult,
} from "../../../src/wagering/application/ports/event-publisher";
import {
  type OutboxPublishingOptions,
  PublishOutboxBatch,
  type PublishOutboxBatchResult,
} from "../../../src/wagering/application/use-cases/publish-outbox-batch";
import type { OutboxMessage } from "../../../src/wagering/domain/messaging/outbox-message";
import { SqsEventPublisher } from "../../../src/wagering/infrastructure/sqs/sqs-event-publisher";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { createTemporaryQueue, type TemporaryQueue } from "../../helpers/sqs";
import { openWallet, useCases, wagerCommand } from "../../helpers/use-cases";

let db: TestDatabase;
let queue: TemporaryQueue;

const OPTIONS: OutboxPublishingOptions = { batchSize: 10, leaseMs: 5_000, publishTimeoutMs: 2_000 };
const systemClock: Clock = { now: () => new Date() };

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  queue = await createTemporaryQueue("outbox-test");
  // Cada teste começa com a outbox vazia: o que sobrou de outro teste não entra na conta.
  await db.sql("delete from outbox_messages");
});

afterEach(async () => {
  await queue.destroy();
});

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  attempts: number;
  next_attempt_at: string;
  published_at: string | null;
  last_error: string | null;
}

const outboxRows = () =>
  db.sql<OutboxRow[]>("select * from outbox_messages order by next_attempt_at, id");

/** Gera eventos reais, pelo caso de uso: cada aposta processada gera dois (Processed + BalanceChanged). */
async function produceEvents(bets: number): Promise<OutboxRow[]> {
  const { createWallet, submit } = useCases(db.unitOfWork);
  const wallet = await openWallet(createWallet, "1000.00");
  for (let i = 0; i < bets; i++) {
    await submit.execute(wagerCommand(wallet, { money: { amount: "1.00", currency: "BRL" } }));
  }
  return outboxRows();
}

function sqsPublisher(queueName = queue.name): SqsEventPublisher {
  return new SqsEventPublisher(queue.sqs, queueName);
}

function publisherOf(
  publisher: EventPublisher,
  options: Partial<OutboxPublishingOptions> = {},
  clock: Clock = systemClock,
): PublishOutboxBatch {
  return new PublishOutboxBatch(
    db.unitOfWork,
    publisher,
    clock,
    { ...OPTIONS, ...options },
    () => 0,
  );
}

/** Roda ciclos até a outbox não ter mais nada vencido. */
async function drain(subject: PublishOutboxBatch): Promise<PublishOutboxBatchResult[]> {
  const results: PublishOutboxBatchResult[] = [];
  for (;;) {
    const result = await subject.execute();
    if (result.claimed === 0) return results;
    results.push(result);
  }
}

const sum = (results: readonly PublishOutboxBatchResult[], key: keyof PublishOutboxBatchResult) =>
  results.reduce((total, result) => total + result[key], 0);

const eventIdsOf = (messages: readonly Message[]) =>
  messages.map((message) => (JSON.parse(message.Body ?? "{}") as { eventId: string }).eventId);

describe("publicação na fila de eventos", () => {
  test("publica o envelope com deduplicação pelo eventId e grupo pela wallet", async () => {
    const rows = await produceEvents(1);

    const result = await publisherOf(sqsPublisher()).execute();
    const received = await queue.receive(rows.length);

    expect(result).toEqual({
      claimed: rows.length,
      published: rows.length,
      retried: 0,
      alreadyPublished: 0,
    });
    expect(eventIdsOf(received).sort()).toEqual(rows.map((row) => row.id).sort());
    for (const message of received) {
      const body = JSON.parse(message.Body ?? "{}") as Record<string, unknown>;
      const row = rows.find((candidate) => candidate.id === body.eventId);
      expect(message.Attributes?.MessageDeduplicationId).toBe(row?.id);
      expect(message.Attributes?.MessageGroupId).toBe(row?.aggregate_id);
      expect(message.MessageAttributes?.eventType?.StringValue).toBe(row?.event_type);
      expect(body).toMatchObject({ eventType: row?.event_type, version: 1 });
    }
    expect((await outboxRows()).every((row) => row.published_at !== null)).toBe(true);
  });

  test("lote cheio: o resto fica para o próximo ciclo, na ordem de criação", async () => {
    const rows = await produceEvents(3); // 6 eventos + 2 da abertura da wallet

    const first = await publisherOf(sqsPublisher(), { batchSize: 5 }).execute();
    const second = await publisherOf(sqsPublisher(), { batchSize: 5 }).execute();
    const received = await queue.receive(rows.length);

    expect([first.published, second.published]).toEqual([5, rows.length - 5]);
    expect(eventIdsOf(received)).toEqual(rows.map((row) => row.id));
  });

  test("publicação duplicada é segura: a mesma mensagem duas vezes chega uma vez", async () => {
    await produceEvents(1);
    const messages = await db.unitOfWork.run(({ outbox }) => outbox.claimDue(new Date(), 10));
    const publisher = sqsPublisher();

    await publisher.publish(messages, AbortSignal.timeout(2_000));
    await publisher.publish(messages, AbortSignal.timeout(2_000));
    const received = await queue.receive(messages.length, { settleMs: 1_500 });

    expect(received).toHaveLength(messages.length);
  });
});

describe("falhas de publicação", () => {
  test("SQS indisponível: nada se perde, retry agendado com backoff; depois publica", async () => {
    const rows = await produceEvents(1);
    const broken = publisherOf(sqsPublisher("does-not-exist.fifo"));

    const failed = await broken.execute();
    const afterFailure = await outboxRows();
    const tooEarly = await publisherOf(sqsPublisher()).execute();
    // Relógio adiantado além do backoff da 1ª tentativa (0,5 a 1 s).
    const later: Clock = { now: () => new Date(Date.now() + 2_000) };
    const recovered = await publisherOf(sqsPublisher(), {}, later).execute();
    const received = await queue.receive(rows.length);

    expect(failed).toMatchObject({ claimed: rows.length, published: 0, retried: rows.length });
    for (const row of afterFailure) {
      expect(row.published_at).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain("QueueDoesNotExist");
    }
    expect(tooEarly.claimed).toBe(0);
    expect(recovered.published).toBe(rows.length);
    expect(received).toHaveLength(rows.length);
    expect((await outboxRows()).every((row) => row.published_at !== null)).toBe(true);
  });

  test("falha parcial do lote: só as recusadas voltam para retry", async () => {
    const rows = await produceEvents(1);
    const rejectedId = rows[0]?.id ?? "";
    const partial: EventPublisher = {
      async publish(messages: readonly OutboxMessage[]): Promise<PublishBatchResult> {
        return {
          published: messages.map((message) => message.id).filter((id) => id !== rejectedId),
          failed: new Map([[rejectedId, "InternalError: try again"]]),
        };
      },
    };

    const result = await publisherOf(partial).execute();
    const after = await outboxRows();

    expect(result).toMatchObject({ published: rows.length - 1, retried: 1 });
    const rejected = after.find((row) => row.id === rejectedId);
    expect(rejected).toMatchObject({ published_at: null, attempts: 1 });
    expect(rejected?.last_error).toBe("InternalError: try again");
    expect(after.filter((row) => row.published_at !== null)).toHaveLength(rows.length - 1);
  });

  test("timeout da chamada ao broker conta como falha do lote inteiro", async () => {
    const rows = await produceEvents(1);
    const hanging: EventPublisher = {
      publish: (_messages, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };

    const result = await publisherOf(hanging, { publishTimeoutMs: 100 }).execute();

    expect(result).toMatchObject({ claimed: rows.length, retried: rows.length });
    expect((await outboxRows()).every((row) => row.last_error?.includes("TimeoutError"))).toBe(
      true,
    );
  });
});

describe("várias instâncias", () => {
  test("dois publishers concorrentes: cada evento publicado exatamente uma vez", async () => {
    const rows = await produceEvents(12); // 26 eventos
    // Publisher lento: segura a reserva enquanto o outro busca, forçando a disputa.
    const slow = (): EventPublisher => {
      const real = sqsPublisher();
      return {
        async publish(messages, signal) {
          await Bun.sleep(30);
          return real.publish(messages, signal);
        },
      };
    };
    const a = publisherOf(slow(), { batchSize: 4 });
    const b = publisherOf(slow(), { batchSize: 4 });

    const [resultsA, resultsB] = await Promise.all([drain(a), drain(b)]);
    const received = await queue.receive(rows.length, { settleMs: 1_000 });

    expect(sum(resultsA, "published")).toBeGreaterThan(0);
    expect(sum(resultsB, "published")).toBeGreaterThan(0);
    expect(sum(resultsA, "published") + sum(resultsB, "published")).toBe(rows.length);
    expect(sum([...resultsA, ...resultsB], "alreadyPublished")).toBe(0);
    expect(eventIdsOf(received).sort()).toEqual(rows.map((row) => row.id).sort());
    expect((await outboxRows()).every((row) => row.published_at !== null)).toBe(true);
  });

  test("commit confirmado, processo morre antes de publicar: outra instância publica", async () => {
    const rows = await produceEvents(1);
    // Instância A reserva o lote (como no passo 1 do ciclo) e morre: nunca publica nem grava.
    const leaseMs = 300;
    await db.unitOfWork.run(async ({ outbox }) => {
      const now = new Date();
      for (const message of await outbox.claimDue(now, 10)) {
        message.reserveUntil(new Date(now.getTime() + leaseMs));
        await outbox.save(message);
      }
    });
    const instanceB = publisherOf(sqsPublisher());

    const whileReserved = await instanceB.execute();
    await Bun.sleep(leaseMs + 50);
    const afterLease = await instanceB.execute();
    const received = await queue.receive(rows.length);

    expect(whileReserved.claimed).toBe(0);
    expect(afterLease.published).toBe(rows.length);
    expect(eventIdsOf(received).sort()).toEqual(rows.map((row) => row.id).sort());
  });

  test("publicou e morreu antes de gravar: a outra instância republica e a fila deduplica", async () => {
    const rows = await produceEvents(1);
    const leaseMs = 300;
    // Instância A reserva, publica no SQS e morre antes de marcar como publicada.
    const messages = await db.unitOfWork.run(async ({ outbox }) => {
      const now = new Date();
      const due = await outbox.claimDue(now, 10);
      for (const message of due) {
        message.reserveUntil(new Date(now.getTime() + leaseMs));
        await outbox.save(message);
      }
      return due;
    });
    await sqsPublisher().publish(messages, AbortSignal.timeout(2_000));
    await Bun.sleep(leaseMs + 50);

    const instanceB = await publisherOf(sqsPublisher()).execute();
    const received = await queue.receive(rows.length, { settleMs: 1_500 });

    expect(instanceB.published).toBe(rows.length);
    expect(received).toHaveLength(rows.length);
  });

  test("publisher atrasado não desfaz a publicação feita por outro", async () => {
    await produceEvents(1);
    const [message] = await db.unitOfWork.run(({ outbox }) => outbox.claimDue(new Date(), 1));
    if (!message) throw new Error("setup");
    // Outro publisher publicou e gravou primeiro.
    await db.sql("update outbox_messages set published_at = now() where id = ?", [message.id]);

    message.scheduleRetry(new Date(), "late failure", () => 0);
    const saved = await db.unitOfWork.run(({ outbox }) => outbox.save(message));

    const [row] = await db.sql<OutboxRow[]>("select * from outbox_messages where id = ?", [
      message.id,
    ]);
    expect(saved).toBe(false);
    expect(row?.published_at).not.toBeNull();
    expect(row?.attempts).toBe(0);
  });
});

describe("lotes maiores que o limite do SQS", () => {
  test("lote de 50 com várias wallets: tudo publicado, ordem preservada dentro de cada wallet", async () => {
    // 5 wallets, cada uma com abertura + 3 apostas: 8 eventos por wallet, 40 no total.
    await Promise.all(Array.from({ length: 5 }, () => produceEvents(3)));
    const rows = await outboxRows();

    const result = await publisherOf(sqsPublisher(), { batchSize: 50 }).execute();
    const received = await queue.receive(rows.length, { settleMs: 1_000 });

    expect(result).toMatchObject({ claimed: rows.length, published: rows.length, retried: 0 });
    expect(received).toHaveLength(rows.length);
    // Dentro de cada wallet (MessageGroupId), a fila entrega na ordem de criação.
    for (const aggregate of new Set(rows.map((row) => row.aggregate_id))) {
      const expected = rows.filter((row) => row.aggregate_id === aggregate).map((row) => row.id);
      const delivered = eventIdsOf(
        received.filter((message) => message.Attributes?.MessageGroupId === aggregate),
      );
      expect(delivered).toEqual(expected);
    }
  });

  test("marcação em lote não sobrescreve o que outro publisher já marcou no meio do caminho", async () => {
    const rows = await produceEvents(1);
    const [stolen] = rows;
    if (!stolen) throw new Error("setup");
    // Confirma tudo, mas antes outro publisher marca uma das mensagens como publicada.
    const racing: EventPublisher = {
      async publish(messages) {
        await db.sql("update outbox_messages set published_at = now() where id = ?", [stolen.id]);
        return { published: messages.map((message) => message.id), failed: new Map() };
      },
    };

    const result = await publisherOf(racing).execute();

    expect(result).toEqual({
      claimed: rows.length,
      published: rows.length - 1,
      retried: 0,
      alreadyPublished: 1,
    });
    expect((await outboxRows()).every((row) => row.published_at !== null)).toBe(true);
  });
});

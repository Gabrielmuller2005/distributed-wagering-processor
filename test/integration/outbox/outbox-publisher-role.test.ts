import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWorkerApp } from "../../../src/app";
import { OutboxPublisherWorker } from "../../../src/wagering/interface/workers/outbox-publisher.worker";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import { ensureTestQueue, startTestApp, testAppConfig } from "../../helpers/http-app";
import { createTemporaryQueue, type TemporaryQueue, waitFor } from "../../helpers/sqs";
import { openWallet, useCases } from "../../helpers/use-cases";

let db: TestDatabase;
let queue: TemporaryQueue;

beforeAll(async () => {
  db = await openTestDatabase();
  queue = await createTemporaryQueue("outbox-role-test");
  await ensureTestQueue(testAppConfig());
});

afterAll(async () => {
  await queue.destroy();
  await db.close();
});

const publisherConfig = (overrides: Record<string, string> = {}) =>
  testAppConfig({
    ENABLE_OUTBOX_PUBLISHER: "true",
    SQS_EVENTS_QUEUE_NAME: queue.name,
    OUTBOX_POLL_INTERVAL_MS: "50",
    ...overrides,
  });

const pendingCount = async () => {
  const [row] = await db.sql<{ count: string }[]>(
    "select count(*)::text as count from outbox_messages where published_at is null",
  );
  return row?.count ?? "";
};

describe("papel ENABLE_OUTBOX_PUBLISHER", () => {
  test("instância HTTP com o publisher: a aposta vira evento na fila sem nenhuma chamada extra", async () => {
    const http = await startTestApp(publisherConfig());
    try {
      const wallet = await http.request<{ id: string; playerId: string }>("POST", "/wallets", {
        body: { playerId: newId(), initialBalance: { amount: "100.00", currency: "BRL" } },
      });
      const externalTransactionId = `tx-${newId()}`;
      const bet = await http.request<{ transactionId: string }>("POST", "/wagering/transactions", {
        headers: { "Idempotency-Key": `provider-a:${externalTransactionId}` },
        body: {
          providerId: "provider-a",
          externalTransactionId,
          playerId: wallet.body.playerId,
          walletId: wallet.body.id,
          roundId: "round-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        },
      });

      // Abertura da wallet (2 eventos) + aposta processada (2 eventos).
      const received = await queue.receive(4);
      const types = received
        .map((message) => JSON.parse(message.Body ?? "{}") as { eventType: string; data: object })
        .filter((event) => JSON.stringify(event.data).includes(bet.body.transactionId))
        .map((event) => event.eventType)
        .sort();

      expect(types).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
      await waitFor(async () => (await pendingCount()) === "0");
    } finally {
      await http.close();
    }
  });

  test("readiness passa a conferir a fila de eventos quando o publisher está ligado", async () => {
    const http = await startTestApp(publisherConfig());
    try {
      const ready = await http.request("GET", "/health/ready");

      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({
        status: "ok",
        checks: { database: "up", sqs: "up", eventsQueue: "up" },
      });
    } finally {
      await http.close();
    }
  });

  test("instância só de workers (sem HTTP) publica o que outra instância gravou", async () => {
    // Commit feito "por outra instância", sem publisher nenhum de pé.
    const { createWallet } = useCases(db.unitOfWork);
    await openWallet(createWallet, "50.00");
    expect(await pendingCount()).not.toBe("0");

    const worker = await createWorkerApp(publisherConfig({ ENABLE_HTTP: "false" }));
    worker.useLogger(false);
    await worker.init();
    try {
      await waitFor(async () => (await pendingCount()) === "0");
      expect(worker.get(OutboxPublisherWorker).isRunning).toBe(true);
    } finally {
      await worker.close();
    }

    expect(worker.get(OutboxPublisherWorker).isRunning).toBe(false);
    expect(await queue.receive(2)).toHaveLength(2);
  });

  test("com o papel desligado, nada é publicado", async () => {
    const http = await startTestApp(publisherConfig({ ENABLE_OUTBOX_PUBLISHER: "false" }));
    try {
      const { createWallet } = useCases(db.unitOfWork);
      await openWallet(createWallet, "50.00");
      await Bun.sleep(300);

      expect(await pendingCount()).toBe("2");
      expect(http.app.get(OutboxPublisherWorker).isRunning).toBe(false);
    } finally {
      await http.close();
      await db.sql("delete from outbox_messages");
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createWorkerApp } from "../../../src/app";
import { SqsConsumerWorker } from "../../../src/wagering/interface/workers/sqs-consumer.worker";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import { startTestApp, testAppConfig } from "../../helpers/http-app";
import { expectLedgerMatchesWallet } from "../../helpers/invariants";
import { createTemporaryQueue, type TemporaryQueue, waitFor } from "../../helpers/sqs";
import { openWallet, useCases } from "../../helpers/use-cases";

let db: TestDatabase;
let main: TemporaryQueue;
let dlq: TemporaryQueue;

beforeAll(async () => {
  db = await openTestDatabase();
  main = await createTemporaryQueue("consumer-role-test");
  dlq = await createTemporaryQueue("consumer-role-test-dlq");
});

afterAll(async () => {
  await main.destroy();
  await dlq.destroy();
  await db.close();
});

const consumerConfig = (overrides: Record<string, string> = {}) =>
  testAppConfig({
    ENABLE_SQS_CONSUMER: "true",
    SQS_QUEUE_NAME: main.name,
    SQS_DLQ_NAME: dlq.name,
    SQS_WAIT_TIME_SECONDS: "1",
    ...overrides,
  });

async function sendBet(amount: string) {
  const wallet = await openWallet(useCases(db.unitOfWork).createWallet, "100.00");
  const externalTransactionId = `transaction-${newId()}`;
  await main.send(
    JSON.stringify({
      messageId: `msg-${newId()}`,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "provider-a",
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-987",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount, currency: "BRL" },
      },
    }),
    { groupId: wallet.id },
  );
  return { wallet, externalTransactionId };
}

const statusOf = async (externalTransactionId: string) => {
  const [row] = await db.sql<{ status: string }[]>(
    "select status from wager_transactions where external_transaction_id = ?",
    [externalTransactionId],
  );
  return row?.status;
};

describe("papel ENABLE_SQS_CONSUMER", () => {
  test("instância HTTP com o consumidor: a mensagem da fila é processada sozinha", async () => {
    const http = await startTestApp(consumerConfig());
    try {
      const { wallet, externalTransactionId } = await sendBet("40.00");

      await waitFor(async () => (await statusOf(externalTransactionId)) === "PROCESSED");
      const ready = await http.request("GET", "/health/ready");

      expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
        balance: "60.00",
      });
      expect(ready.body).toEqual({
        status: "ok",
        checks: { database: "up", sqs: "up", deadLetterQueue: "up" },
      });
    } finally {
      await http.close();
    }
  });

  test("instância só de consumidor; no SIGTERM, o que o long polling trouxer volta para a fila", async () => {
    const worker = await createWorkerApp(
      consumerConfig({ ENABLE_HTTP: "false", SQS_WAIT_TIME_SECONDS: "2" }),
    );
    worker.useLogger(false);
    await worker.init();
    const processed = await sendBet("10.00");
    await waitFor(async () => (await statusOf(processed.externalTransactionId)) === "PROCESSED");
    expect(worker.get(SqsConsumerWorker).isRunning).toBe(true);

    // O SIGTERM chega com um long polling aberto, e uma mensagem chega logo depois.
    const closing = worker.close();
    const late = await sendBet("10.00");
    await closing;

    expect(worker.get(SqsConsumerWorker).isRunning).toBe(false);
    expect(await statusOf(late.externalTransactionId)).toBeUndefined();
    // Devolvida com visibilidade 0, e não presa até o visibility timeout (30 s).
    expect(await main.receive(1, { timeoutMs: 2_000 })).toHaveLength(1);
  });

  test("com o papel desligado, a mensagem fica na fila", async () => {
    const http = await startTestApp(consumerConfig({ ENABLE_SQS_CONSUMER: "false" }));
    try {
      const { externalTransactionId } = await sendBet("10.00");
      await Bun.sleep(500);

      expect(await statusOf(externalTransactionId)).toBeUndefined();
      expect(await main.receive(1)).toHaveLength(1);
    } finally {
      await http.close();
    }
  });
});

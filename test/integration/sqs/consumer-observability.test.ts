import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Logger } from "@nestjs/common";
import { SystemClock } from "../../../src/shared/application/clock";
import { UuidV7Generator } from "../../../src/shared/application/id-generator";
import { createRootLogger, PinoLoggerService } from "../../../src/shared/observability/logger";
import { SubmitWagerTransaction } from "../../../src/wagering/application/use-cases/submit-wager-transaction";
import { WageringMetrics } from "../../../src/wagering/infrastructure/observability/wagering-metrics";
import { SqsQueueConsumer } from "../../../src/wagering/infrastructure/sqs/sqs-queue-consumer";
import { WagerTransactionMessageHandler } from "../../../src/wagering/interface/sqs/wager-transaction-message-handler";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import { createTemporaryQueue, type TemporaryQueue } from "../../helpers/sqs";
import { openWallet, useCases } from "../../helpers/use-cases";

let db: TestDatabase;
let main: TemporaryQueue;
let dlq: TemporaryQueue;
const lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
  main = await createTemporaryQueue("consumer-obs");
  dlq = await createTemporaryQueue("consumer-obs-dlq");
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  // Os logs do Nest Logger passam a sair pelo pino, capturados aqui.
  Logger.overrideLogger(new PinoLoggerService(createRootLogger("info", stream)));
});

afterAll(async () => {
  Logger.overrideLogger(false);
  await main.destroy();
  await dlq.destroy();
  await db.close();
});

describe("observabilidade do consumidor SQS", () => {
  test("cada mensagem gera uma linha com messageId, transactionId, walletId e providerId; DLQ e retry viram métricas", async () => {
    const metrics = new WageringMetrics();
    const handler = new WagerTransactionMessageHandler(
      new SubmitWagerTransaction(db.unitOfWork, new UuidV7Generator(), new SystemClock()),
      metrics,
    );
    const consumer = new SqsQueueConsumer(
      main.sqs,
      handler.handle,
      {
        queueName: main.name,
        deadLetterQueueName: dlq.name,
        batchSize: 10,
        waitTimeSeconds: 1,
        maxReceiveCount: 3,
        retryBackoff: { baseDelayMs: 1_000, maxDelayMs: 1_000 },
      },
      new Logger("SqsConsumer"),
      () => 0,
      {
        retryScheduled: (reason) => metrics.retryScheduled("sqs_consumer", reason),
        deadLettered: (reason) => metrics.deadLettered(reason),
      },
    );
    const wallet = await openWallet(useCases(db.unitOfWork).createWallet, "500.00");
    const externalTransactionId = `transaction-${newId()}`;
    const messageId = `msg-${newId()}`;
    await main.send(
      JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        correlationId: "corr-sqs-obs",
        data: {
          providerId: "provider-a",
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "round-987",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "43.21", currency: "BRL" },
        },
      }),
      { groupId: wallet.id },
    );
    await main.send("not json", { groupId: "garbage" });

    const result = await consumer.consumeBatch(AbortSignal.timeout(5_000));
    await Bun.sleep(20);

    expect(result).toMatchObject({ acked: 1, deadLettered: 1 });
    const handled = lines.find(
      (line) => line.msg === "sqs message handled" && line.messageId === messageId,
    );
    expect(handled).toMatchObject({
      level: "info",
      context: "SqsConsumer",
      disposition: "ack",
      status: "PROCESSED",
      correlationId: "corr-sqs-obs",
      walletId: wallet.id,
      providerId: "provider-a",
    });
    expect(typeof handled?.transactionId).toBe("string");
    expect(typeof handled?.sqsMessageId).toBe("string");
    // A linha da DLQ (escrita pelo consumidor genérico) carrega o id SQS da mensagem.
    const deadLetter = lines.find((line) =>
      String(line.msg).includes("sent to the dead-letter queue"),
    );
    expect(typeof deadLetter?.sqsMessageId).toBe("string");
    expect(JSON.stringify(lines)).not.toContain("43.21");

    const text = await metrics.render();
    expect(text).toContain(
      'wagering_transactions_total{channel="sqs",status="PROCESSED",replay="false"} 1',
    );
    expect(text).toContain('wagering_dead_letter_messages_total{reason="INVALID_ENVELOPE"} 1');
  });
});

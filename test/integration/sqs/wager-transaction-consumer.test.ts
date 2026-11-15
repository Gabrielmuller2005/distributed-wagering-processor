import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { Logger } from "@nestjs/common";
import { SystemClock } from "../../../src/shared/application/clock";
import { UuidV7Generator } from "../../../src/shared/application/id-generator";
import { SubmitWagerTransaction } from "../../../src/wagering/application/use-cases/submit-wager-transaction";
import type { WalletView } from "../../../src/wagering/application/views";
import { WagerTransactionStatus } from "../../../src/wagering/domain/wager-transaction/wager-transaction-status";
import { MikroOrmUnitOfWork } from "../../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";
import {
  type MessageHandler,
  type QueueConsumerOptions,
  SqsQueueConsumer,
} from "../../../src/wagering/infrastructure/sqs/sqs-queue-consumer";
import {
  WAGER_TRANSACTIONS_CONSUMER,
  WagerTransactionMessageHandler,
} from "../../../src/wagering/interface/sqs/wager-transaction-message-handler";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import { expectLedgerMatchesWallet } from "../../helpers/invariants";
import { createTemporaryQueue, type TemporaryQueue } from "../../helpers/sqs";
import { openWallet, useCases } from "../../helpers/use-cases";

let db: TestDatabase;
let main: TemporaryQueue;
let dlq: TemporaryQueue;

const silent = { warn: () => {}, error: () => {} };

beforeAll(async () => {
  // O handler loga cada mensagem pelo Logger do Nest; aqui não há aplicação para recebê-los.
  Logger.overrideLogger(false);
  db = await openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  main = await createTemporaryQueue("consumer-test");
  dlq = await createTemporaryQueue("consumer-test-dlq");
});

afterEach(async () => {
  await main.destroy();
  await dlq.destroy();
});

/** Caso de uso real; `lockTimeoutMs` curto permite provocar falha transitória de propósito. */
function handlerWith(lockTimeoutMs = 2_000): WagerTransactionMessageHandler {
  const unitOfWork = new MikroOrmUnitOfWork(db.orm, lockTimeoutMs);
  return new WagerTransactionMessageHandler(
    new SubmitWagerTransaction(unitOfWork, new UuidV7Generator(), new SystemClock()),
  );
}

function consumerWith(
  handler: MessageHandler,
  options: Partial<QueueConsumerOptions> = {},
): SqsQueueConsumer {
  return new SqsQueueConsumer(
    main.sqs,
    handler,
    {
      queueName: main.name,
      deadLetterQueueName: dlq.name,
      batchSize: 10,
      waitTimeSeconds: 1,
      maxReceiveCount: 3,
      // random = 0 → metade do atraso: 0,5 s, arredondado para 1 s de visibilidade.
      retryBackoff: { baseDelayMs: 1_000, maxDelayMs: 1_000 },
      ...options,
    },
    silent,
    () => 0,
  );
}

async function wallet(amount = "100.00"): Promise<WalletView> {
  return openWallet(useCases(db.unitOfWork).createWallet, amount);
}

/** Mensagem no formato da seção 10 do enunciado. */
function envelope(
  target: WalletView,
  data: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const externalTransactionId = `transaction-${newId()}`;
  return {
    messageId: `msg-${newId()}`,
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: target.playerId,
      walletId: target.id,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...data,
    },
    ...extra,
  };
}

const sendEnvelope = (message: object, groupId: string) =>
  main.send(JSON.stringify(message), { groupId });

/** Roda ciclos até a fila esvaziar (ou o prazo acabar), somando os resultados. */
async function consumeUntilEmpty(consumer: SqsQueueConsumer, timeoutMs = 10_000) {
  const totals = { received: 0, acked: 0, retried: 0, deadLettered: 0, released: 0 };
  const deadline = Date.now() + timeoutMs;
  let emptyRounds = 0;
  while (Date.now() < deadline && emptyRounds < 2) {
    const result = await consumer.consumeBatch(AbortSignal.timeout(5_000));
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += result[key];
    emptyRounds = result.received === 0 ? emptyRounds + 1 : 0;
  }
  return totals;
}

async function transactionStatus(externalId: string): Promise<string | undefined> {
  const [row] = await db.sql<{ status: string }[]>(
    "select status from wager_transactions where external_transaction_id = ?",
    [externalId],
  );
  return row?.status;
}

const dataOf = (message: ReturnType<typeof envelope>) =>
  message.data as { externalTransactionId: string };

describe("processamento", () => {
  test("mensagem do enunciado: aplica pelo mesmo caso de uso, registra a inbox e faz ack", async () => {
    const target = await wallet("100.00");
    const message = envelope(target, {}, { correlationId: "corr-sqs-1" });
    await sendEnvelope(message, target.id);

    const result = await consumerWith(handlerWith().handle).consumeBatch(
      AbortSignal.timeout(5_000),
    );

    expect(result).toMatchObject({ received: 1, acked: 1 });
    expect(await transactionStatus(dataOf(message).externalTransactionId)).toBe("PROCESSED");
    expect(await expectLedgerMatchesWallet(db.unitOfWork, target.id)).toMatchObject({
      balance: "75.00",
      debits: 1,
    });
    const inbox = await db.sql<{ processed_at: string | null }[]>(
      "select processed_at from inbox_messages where consumer_name = ? and message_id = ?",
      [WAGER_TRANSACTIONS_CONSUMER, message.messageId],
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.processed_at).not.toBeNull();
    // Os eventos levam o correlationId do envelope e o messageId como causa.
    const events = await db.sql<{ correlation: string; causation: string }[]>(
      `select payload ->> 'correlationId' as correlation, payload ->> 'causationId' as causation
       from outbox_messages where payload -> 'data' ->> 'walletId' = ? and event_type = 'WalletBalanceChanged'
       order by occurred_at desc limit 1`,
      [target.id],
    );
    expect(events[0]).toEqual({ correlation: "corr-sqs-1", causation: message.messageId });
    expect(await main.receive(1, { timeoutMs: 1_500 })).toHaveLength(0);
  });

  test("rejeição de negócio é resultado confirmado: ack, sem DLQ", async () => {
    const target = await wallet("10.00");
    const message = envelope(target, { money: { amount: "25.00", currency: "BRL" } });
    await sendEnvelope(message, target.id);

    const result = await consumeUntilEmpty(consumerWith(handlerWith().handle));

    expect(result).toMatchObject({ acked: 1, deadLettered: 0, retried: 0 });
    expect(await transactionStatus(dataOf(message).externalTransactionId)).toBe("REJECTED");
    expect(await dlq.receive(1, { timeoutMs: 1_500 })).toHaveLength(0);
  });

  test("REFUND antes da BET fica PENDING_REFERENCE: também é ack", async () => {
    const target = await wallet("100.00");
    const message = envelope(target, {
      kind: "REFUND",
      referenceExternalTransactionId: "bet-not-arrived",
    });
    await sendEnvelope(message, target.id);

    const result = await consumeUntilEmpty(consumerWith(handlerWith().handle));

    expect(result.acked).toBe(1);
    expect(await transactionStatus(dataOf(message).externalTransactionId)).toBe(
      "PENDING_REFERENCE",
    );
  });

  test("wallets diferentes em grupos diferentes são processadas no mesmo lote", async () => {
    const wallets = await Promise.all([wallet(), wallet(), wallet(), wallet()]);
    for (const target of wallets) await sendEnvelope(envelope(target), target.id);

    const result = await consumeUntilEmpty(consumerWith(handlerWith().handle));

    expect(result.acked).toBe(4);
    for (const target of wallets) {
      expect(await expectLedgerMatchesWallet(db.unitOfWork, target.id)).toMatchObject({
        balance: "75.00",
        debits: 1,
      });
    }
  });
});

describe("redelivery sem duplicar efeitos", () => {
  test("a mesma mensagem entregue de novo vira replay: um único débito", async () => {
    const target = await wallet("100.00");
    const message = envelope(target);
    // Dois envios com ids de deduplicação diferentes: o SQS entrega os dois.
    await sendEnvelope(message, target.id);
    await sendEnvelope(message, target.id);

    const result = await consumeUntilEmpty(consumerWith(handlerWith().handle));

    expect(result).toMatchObject({ received: 2, acked: 2 });
    expect(await expectLedgerMatchesWallet(db.unitOfWork, target.id)).toMatchObject({
      balance: "75.00",
      debits: 1,
    });
  });

  test("worker morre depois do commit e antes do ack: a reentrega não duplica", async () => {
    const target = await wallet("100.00");
    const message = envelope(target);
    await sendEnvelope(message, target.id);
    const handler = handlerWith();

    // Instância A: recebe, processa (commit) e morre sem apagar a mensagem.
    const received = await main.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: main.url, WaitTimeSeconds: 1, VisibilityTimeout: 1 }),
    );
    const [first] = received.Messages ?? [];
    if (!first?.Body) throw new Error("setup");
    const firstOutcome = await handler.handleDetailed({
      body: first.Body,
      sqsMessageId: first.MessageId ?? "",
      receiveCount: 1,
    });

    // Instância B: recebe a reentrega quando a visibilidade vence.
    const result = await consumeUntilEmpty(consumerWith(handler.handle));

    expect(firstOutcome.result?.status).toBe(WagerTransactionStatus.Processed);
    expect(result).toMatchObject({ received: 1, acked: 1 });
    expect(await expectLedgerMatchesWallet(db.unitOfWork, target.id)).toMatchObject({
      balance: "75.00",
      debits: 1,
    });
  });

  test("mesmo messageId com outro conteúdo vai para a DLQ, sem efeito", async () => {
    const target = await wallet("100.00");
    const original = envelope(target);
    const tampered = {
      ...envelope(target, { money: { amount: "99.00", currency: "BRL" } }),
      messageId: original.messageId,
    };
    await sendEnvelope(original, target.id);
    await sendEnvelope(tampered, target.id);

    const result = await consumeUntilEmpty(consumerWith(handlerWith().handle));
    const [dead] = await dlq.receive(1);

    expect(result).toMatchObject({ acked: 1, deadLettered: 1 });
    expect(dead?.MessageAttributes?.deadLetterReason?.StringValue).toBe("INBOX_MESSAGE_CONFLICT");
    expect(await transactionStatus(dataOf(tampered).externalTransactionId)).toBeUndefined();
  });
});

describe("erros permanentes vão direto para a DLQ", () => {
  test.each([
    ["JSON malformado", () => '{"messageId": ', "INVALID_ENVELOPE: body is not valid JSON"],
    [
      "tipo desconhecido",
      (target: WalletView) => JSON.stringify(envelope(target, {}, { type: "Other" })),
      "INVALID_ENVELOPE: type must be WagerTransactionRequested",
    ],
    [
      "sem messageId",
      (target: WalletView) => JSON.stringify({ ...envelope(target), messageId: undefined }),
      "INVALID_ENVELOPE: messageId is required",
    ],
    [
      "amount como número",
      (target: WalletView) =>
        JSON.stringify(envelope(target, { money: { amount: 25, currency: "BRL" } })),
      "VALIDATION_ERROR: INVALID_AMOUNT (money)",
    ],
    [
      "sem idempotencyKey",
      (target: WalletView) => JSON.stringify(envelope(target, { idempotencyKey: undefined })),
      "VALIDATION_ERROR: IDEMPOTENCY_KEY_REQUIRED (idempotencyKey)",
    ],
    [
      "wallet inexistente",
      (target: WalletView) => JSON.stringify(envelope({ ...target, id: newId() })),
      "WALLET_NOT_FOUND",
    ],
  ])("%s", async (_name, body, reason) => {
    const target = await wallet("100.00");
    const sent = body(target);
    await main.send(sent, { groupId: target.id });

    const result = await consumeUntilEmpty(consumerWith(handlerWith().handle));
    const [dead] = await dlq.receive(1);

    expect(result).toMatchObject({ received: 1, deadLettered: 1, retried: 0 });
    expect(dead?.Body).toBe(sent);
    expect(dead?.MessageAttributes?.deadLetterReason?.StringValue).toBe(reason);
    expect(dead?.MessageAttributes?.originalMessageId?.StringValue).toBeTruthy();
    expect(await expectLedgerMatchesWallet(db.unitOfWork, target.id)).toMatchObject({
      balance: "100.00",
      debits: 0,
    });
  });

  test("conflito de idempotência (mesma chave, payload diferente) vai para a DLQ", async () => {
    const target = await wallet("100.00");
    const first = envelope(target);
    const conflicting = envelope(target, {
      externalTransactionId: first.data.externalTransactionId,
      idempotencyKey: first.data.idempotencyKey,
      money: { amount: "30.00", currency: "BRL" },
    });
    await sendEnvelope(first, target.id);
    await sendEnvelope(conflicting, target.id);

    const result = await consumeUntilEmpty(consumerWith(handlerWith().handle));
    const [dead] = await dlq.receive(1);

    expect(result).toMatchObject({ acked: 1, deadLettered: 1 });
    expect(dead?.MessageAttributes?.deadLetterReason?.StringValue).toBe(
      "IDEMPOTENCY_CONFLICT: PAYLOAD_MISMATCH",
    );
    expect((await expectLedgerMatchesWallet(db.unitOfWork, target.id)).debits).toBe(1);
  });
});

describe("erros transitórios: retry com backoff e limite antes da DLQ", () => {
  /** Segura o lock da wallet por `ms`, como outra instância com uma transação longa. */
  function holdWalletLock(walletId: string, ms: number): Promise<void> {
    return db.unitOfWork.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(walletId);
      await Bun.sleep(ms);
    });
  }

  test("lock indisponível na 1ª entrega: a mensagem volta depois do backoff e é aplicada uma vez", async () => {
    const target = await wallet("100.00");
    const message = envelope(target);
    await sendEnvelope(message, target.id);
    const holder = holdWalletLock(target.id, 600);
    await Bun.sleep(50);

    const result = await consumeUntilEmpty(consumerWith(handlerWith(200).handle));
    await holder;

    expect(result).toMatchObject({ retried: 1, acked: 1, deadLettered: 0 });
    expect(await transactionStatus(dataOf(message).externalTransactionId)).toBe("PROCESSED");
    expect((await expectLedgerMatchesWallet(db.unitOfWork, target.id)).debits).toBe(1);
  });

  test("falha transitória persistente: esgota as entregas e vai para a DLQ, sem efeito", async () => {
    const target = await wallet("100.00");
    const message = envelope(target);
    await sendEnvelope(message, target.id);
    const holder = holdWalletLock(target.id, 4_000);
    await Bun.sleep(50);

    const result = await consumeUntilEmpty(
      consumerWith(handlerWith(200).handle, { maxReceiveCount: 2 }),
    );
    const [dead] = await dlq.receive(1);
    await holder;

    expect(result).toMatchObject({ received: 2, retried: 1, deadLettered: 1, acked: 0 });
    expect(dead?.MessageAttributes?.deadLetterReason?.StringValue).toBe(
      "MAX_RECEIVE_COUNT_EXCEEDED (2): LOCK_TIMEOUT",
    );
    expect(dead?.MessageAttributes?.receiveCount?.StringValue).toBe("2");
    expect(await transactionStatus(dataOf(message).externalTransactionId)).toBeUndefined();
    expect((await expectLedgerMatchesWallet(db.unitOfWork, target.id)).debits).toBe(0);
  });

  test("erro inesperado do handler é tratado como transitório", async () => {
    const target = await wallet("100.00");
    await sendEnvelope(envelope(target), target.id);
    const exploding: MessageHandler = async () => {
      throw new Error("boom");
    };

    const result = await consumeUntilEmpty(consumerWith(exploding, { maxReceiveCount: 1 }));
    const [dead] = await dlq.receive(1);

    expect(result).toMatchObject({ deadLettered: 1 });
    expect(dead?.MessageAttributes?.deadLetterReason?.StringValue).toBe(
      "MAX_RECEIVE_COUNT_EXCEEDED (1): UNEXPECTED_ERROR: Error: boom",
    );
  });

  test("retry no meio de um grupo devolve as seguintes sem processar, preservando a ordem", async () => {
    const target = await wallet("100.00");
    const messages = [envelope(target), envelope(target), envelope(target)];
    for (const message of messages) await sendEnvelope(message, target.id);
    const handler = handlerWith();
    let calls = 0;
    const failsFirstTime: MessageHandler = async (message) => {
      calls += 1;
      if (calls === 1) return { kind: "retry", reason: "LOCK_TIMEOUT" };
      return handler.handle(message);
    };
    const consumer = consumerWith(failsFirstTime);

    const first = await consumer.consumeBatch(AbortSignal.timeout(5_000));
    const rest = await consumeUntilEmpty(consumer);

    expect(first).toMatchObject({ received: 3, retried: 1, released: 2 });
    expect(rest.acked).toBe(3);
    const processedOrder = await db.sql<{ external_transaction_id: string }[]>(
      "select external_transaction_id from wager_transactions where wallet_id = ? and kind = 'BET' order by created_at",
      [target.id],
    );
    expect(processedOrder.map((row) => row.external_transaction_id)).toEqual(
      messages.map((message) => dataOf(message).externalTransactionId),
    );
  });
});

describe("encerramento gracioso", () => {
  test("SIGTERM com lote em andamento: a mensagem em processamento termina; as outras voltam à fila", async () => {
    const target = await wallet("100.00");
    for (let i = 0; i < 3; i++) await sendEnvelope(envelope(target), target.id);
    const handler = handlerWith();
    let stopping = false;
    const slow: MessageHandler = async (message) => {
      stopping = true; // o sinal chega enquanto a 1ª mensagem processa
      await Bun.sleep(200);
      return handler.handle(message);
    };

    const result = await consumerWith(slow).consumeBatch(
      AbortSignal.timeout(5_000),
      () => !stopping,
    );
    // Devolvidas com visibilidade 0: outra instância as pega na hora.
    const startedAt = Date.now();
    const next = await consumeUntilEmpty(consumerWith(handler.handle));

    expect(result).toMatchObject({ received: 3, acked: 1, released: 2 });
    expect(next.acked).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(await expectLedgerMatchesWallet(db.unitOfWork, target.id)).toMatchObject({
      balance: "25.00",
      debits: 3,
    });
  });

  test("abortar o long polling devolve na hora, sem mensagens", async () => {
    const consumer = consumerWith(handlerWith().handle, { waitTimeSeconds: 10 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);

    const startedAt = Date.now();
    const result = await consumer.consumeBatch(abort.signal);

    expect(result.received).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

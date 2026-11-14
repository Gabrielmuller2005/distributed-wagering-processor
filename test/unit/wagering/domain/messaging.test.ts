import { describe, expect, test } from "bun:test";
import { WagerTransactionProcessed } from "../../../../src/wagering/domain/events/wager-transaction-processed";
import { InboxMessage } from "../../../../src/wagering/domain/messaging/inbox-message";
import { InvalidMessageStateError } from "../../../../src/wagering/domain/messaging/messaging.errors";
import {
  OUTBOX_RETRY_POLICY,
  OutboxMessage,
} from "../../../../src/wagering/domain/messaging/outbox-message";
import { Money } from "../../../../src/wagering/domain/money";
import { WagerTransaction } from "../../../../src/wagering/domain/wager-transaction/wager-transaction";
import { WagerTransactionKind } from "../../../../src/wagering/domain/wager-transaction/wager-transaction-kind";

const T0 = new Date("2026-07-29T15:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

function processedEvent(): WagerTransactionProcessed {
  const tx = WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    createdAt: T0,
  });
  tx.markProcessed({ balanceAfter: Money.from({ amount: "75.00", currency: "BRL" }), at: T0 });
  return WagerTransactionProcessed.from(tx, {
    eventId: "event-1",
    correlationId: "corr-1",
    occurredAt: T0,
  });
}

describe("InboxMessage", () => {
  const receive = () =>
    InboxMessage.receive({
      messageId: "msg-123",
      consumerName: "wager-transactions-consumer",
      payloadHash: "hash-1",
      receivedAt: T0,
    });

  test("nasce não processada", () => {
    const inbox = receive();

    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();
  });

  test("markProcessed registra o horário", () => {
    const inbox = receive();

    inbox.markProcessed(at(10));

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(at(10));
  });

  test("não pode ser processada duas vezes", () => {
    const inbox = receive();
    inbox.markProcessed(at(10));

    expect(() => inbox.markProcessed(at(20))).toThrow(InvalidMessageStateError);
    expect(inbox.processedAt).toEqual(at(10));
  });

  test("matchesPayload distingue redelivery de messageId reutilizado", () => {
    expect(receive().matchesPayload("hash-1")).toBe(true);
    expect(receive().matchesPayload("hash-2")).toBe(false);
  });

  test.each(["messageId", "consumerName", "payloadHash"] as const)("rejeita %s vazio", (field) => {
    expect(() =>
      InboxMessage.receive({
        messageId: "m",
        consumerName: "c",
        payloadHash: "h",
        receivedAt: T0,
        [field]: " ",
      }),
    ).toThrow(InvalidMessageStateError);
  });

  test("rehydrate reconstrói o estado processado", () => {
    const inbox = InboxMessage.rehydrate({
      messageId: "msg-123",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: T0,
      processedAt: at(5),
    });

    expect(inbox.isProcessed()).toBe(true);
  });
});

describe("OutboxMessage.enqueue", () => {
  test("usa o eventId como id e grava o envelope serializado", () => {
    const event = processedEvent();

    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe("event-1");
    expect(message.aggregateId).toBe("wallet-1");
    expect(message.eventType).toBe("WagerTransactionProcessed");
    expect(message.payload).toEqual(JSON.parse(JSON.stringify(event)));
    expect(message.occurredAt).toEqual(T0);
  });

  test("o payload é JSON puro, congelado e independente do evento", () => {
    const message = OutboxMessage.enqueue(processedEvent());
    const data = message.payload.data as { money: { amount: unknown } };

    expect(Object.isFrozen(message.payload)).toBe(true);
    expect(Object.isFrozen(data.money)).toBe(true);
    expect(typeof data.money.amount).toBe("string");
    expect(typeof message.payload.occurredAt).toBe("string");
  });

  test("nasce pendente, sem tentativas e disponível na hora", () => {
    const message = OutboxMessage.enqueue(processedEvent());

    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toEqual(T0);
    expect(message.isDue(T0)).toBe(true);
    expect(message.isDue(at(-1))).toBe(false);
  });
});

describe("OutboxMessage: publicação e retry", () => {
  test("markPublished tira a mensagem da fila de pendentes", () => {
    const message = OutboxMessage.enqueue(processedEvent());

    message.markPublished(at(50));

    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(at(50));
    expect(message.isDue(at(1_000_000))).toBe(false);
  });

  test("não publica duas vezes nem agenda retry depois de publicada", () => {
    const message = OutboxMessage.enqueue(processedEvent());
    message.markPublished(at(50));

    expect(() => message.markPublished(at(60))).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(at(60))).toThrow(InvalidMessageStateError);
    expect(message.publishedAt).toEqual(at(50));
  });

  test("scheduleRetry incrementa attempts e agenda com backoff exponencial", () => {
    const message = OutboxMessage.enqueue(processedEvent());
    const half = () => 0.5;

    message.scheduleRetry(T0, "SQS unavailable", half);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(at(750));
    expect(message.lastError).toBe("SQS unavailable");

    message.scheduleRetry(T0, "SQS unavailable", half);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(at(1_500));

    message.scheduleRetry(T0, undefined, half);
    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt).toEqual(at(3_000));
    expect(message.lastError).toBeUndefined();
  });

  test("reserveUntil esconde a mensagem até o fim da reserva, sem contar tentativa", () => {
    const message = OutboxMessage.enqueue(processedEvent());

    message.reserveUntil(at(30_000));

    expect(message.attempts).toBe(0);
    expect(message.isDue(at(29_999))).toBe(false);
    expect(message.isDue(at(30_000))).toBe(true);
  });

  test("reserveUntil recusa mensagem já publicada", () => {
    const message = OutboxMessage.enqueue(processedEvent());
    message.markPublished(at(1));

    expect(() => message.reserveUntil(at(30_000))).toThrow(InvalidMessageStateError);
  });

  test("isDue respeita o nextAttemptAt agendado", () => {
    const message = OutboxMessage.enqueue(processedEvent());

    message.scheduleRetry(T0, "boom", () => 0);

    expect(message.isDue(at(499))).toBe(false);
    expect(message.isDue(at(500))).toBe(true);
  });

  test("não desiste: depois de muitas falhas, o atraso fica preso no teto", () => {
    const message = OutboxMessage.enqueue(processedEvent());

    for (let i = 0; i < 50; i++) message.scheduleRetry(T0, "down", () => 0.999_999);

    expect(message.attempts).toBe(50);
    expect(message.isPending()).toBe(true);
    expect(message.nextAttemptAt.getTime() - T0.getTime()).toBeLessThan(
      OUTBOX_RETRY_POLICY.maxDelayMs,
    );
  });

  test("trunca mensagens de erro longas", () => {
    const message = OutboxMessage.enqueue(processedEvent());

    message.scheduleRetry(T0, "x".repeat(5_000));

    expect(message.lastError).toHaveLength(1_000);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openTestDatabase, type TestDatabase } from "../helpers/database";
import { newId } from "../helpers/fixtures";
import { ensureTestQueue, testAppConfig } from "../helpers/http-app";
import { type AppInstance, killAll, spawnInstance } from "../helpers/instances";
import { expectLedgerMatchesWallet } from "../helpers/invariants";
import { createTemporaryQueue, waitFor } from "../helpers/sqs";
import { openWallet, useCases } from "../helpers/use-cases";

/**
 * Quedas reais: o processo do serviço é morto com SIGKILL num ponto exato entre duas operações
 * que não são atômicas entre si (fault injection por `FAULT_INJECTION`, só em teste), ou no meio
 * de uma carga. Outra instância assume, e o estado final é conferido no banco e nas filas.
 */

let db: TestDatabase;
const running: AppInstance[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
  await ensureTestQueue(testAppConfig());
});

beforeEach(async () => {
  // A outbox de outros testes não entra na conta deste.
  await db.sql("update outbox_messages set published_at = now() where published_at is null");
});

afterEach(async () => {
  await killAll(running.splice(0));
});

afterAll(async () => {
  await db.close();
});

async function start(name: string, overrides: Record<string, string> = {}) {
  const instance = await spawnInstance(name, overrides);
  running.push(instance);
  return instance;
}

interface Wallet {
  id: string;
  playerId: string;
}

const pendingOutbox = async () => {
  const [row] = await db.sql<{ count: number }[]>(
    "select count(*)::int as count from outbox_messages where published_at is null",
  );
  return row?.count ?? -1;
};

const outboxIdsOfWallet = async (walletId: string) =>
  (
    await db.sql<{ id: string }[]>(
      "select id from outbox_messages where aggregate_id = ? order by id",
      [walletId],
    )
  ).map((row) => row.id);

const eventIdsOf = (bodies: readonly (string | undefined)[]) =>
  bodies.map((body) => (JSON.parse(body ?? "{}") as { eventId: string }).eventId);

describe("worker morto depois do commit e antes do ack", () => {
  test("a reentrega cai noutra instância, vira replay e não duplica o débito", async () => {
    // Visibility timeout curto: a reentrega acontece em 2 s, não em 30.
    const queue = await createTemporaryQueue("crash-ack", { VisibilityTimeout: "2" });
    try {
      const wallet = await openWallet(useCases(db.unitOfWork).createWallet, "100.00");
      const externalTransactionId = `transaction-${newId()}`;
      await queue.send(
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
            money: { amount: "25.00", currency: "BRL" },
          },
        }),
        { groupId: wallet.id },
      );
      const consumerEnv = {
        ENABLE_SQS_CONSUMER: "true",
        SQS_QUEUE_NAME: queue.name,
      };

      // Instância A: processa, confirma no banco e morre antes de apagar a mensagem.
      const doomed = await start("doomed-consumer", {
        ...consumerEnv,
        FAULT_INJECTION: "after-commit-before-ack",
      });
      await doomed.exited;
      const [committed] = await db.sql<{ status: string }[]>(
        "select status from wager_transactions where external_transaction_id = ?",
        [externalTransactionId],
      );
      expect(doomed.output()).toContain(
        "fault injection: killing process at after-commit-before-ack",
      );
      expect(committed?.status).toBe("PROCESSED");

      // Instância B: recebe a reentrega quando a visibilidade vence.
      const survivor = await start("survivor-consumer", consumerEnv);
      await waitFor(
        async () => {
          const metrics = await survivor.request<string>("GET", "/metrics");
          return metrics.body.includes(
            'wagering_transactions_total{channel="sqs",status="PROCESSED",replay="true"} 1',
          );
        },
        { timeoutMs: 20_000, intervalMs: 200 },
      );

      expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
        balance: "75.00",
        debits: 1,
      });
      const [inbox] = await db.sql<{ count: number }[]>(
        "select count(*)::int as count from inbox_messages",
      );
      expect(inbox?.count).toBe(1);
    } finally {
      await killAll(running.splice(0));
      await queue.destroy();
    }
  }, 60_000);
});

describe("outbox: commit confirmado e processo morto antes de terminar a publicação", () => {
  const publisherEnv = (eventsQueue: string) => ({
    ENABLE_OUTBOX_PUBLISHER: "true",
    SQS_EVENTS_QUEUE_NAME: eventsQueue,
    OUTBOX_LEASE_MS: "1500",
    OUTBOX_PUBLISH_TIMEOUT_MS: "1000",
  });

  test.each([
    ["morre antes de publicar", "after-reserve-before-publish"],
    ["publica e morre antes de gravar (duplicata)", "after-publish-before-record"],
  ])(
    "%s: outra instância publica, e cada evento chega uma vez",
    async (_name, point) => {
      const events = await createTemporaryQueue("crash-outbox");
      try {
        // Instância A: grava a wallet (commit), reserva o lote da outbox e morre no ponto.
        const doomed = await start("doomed-publisher", {
          ...publisherEnv(events.name),
          FAULT_INJECTION: point,
        });
        const created = await doomed.request<Wallet>("POST", "/wallets", {
          body: { playerId: newId(), initialBalance: { amount: "50.00", currency: "BRL" } },
        });
        await doomed.exited;
        const eventIds = await outboxIdsOfWallet(created.body.id);
        expect(created.status).toBe(201);
        expect(eventIds).toHaveLength(2);
        expect(await pendingOutbox()).toBe(2);

        // Instância B: assume quando a reserva vence.
        await start("survivor-publisher", {
          ...publisherEnv(events.name),
          ENABLE_HTTP: "false",
        });
        await waitFor(async () => (await pendingOutbox()) === 0, {
          timeoutMs: 20_000,
          intervalMs: 100,
        });
        const received = await events.receive(2, { settleMs: 1_500 });

        // Mesmo quando A chegou a publicar, a fila deduplica pelo eventId: uma cópia de cada.
        expect(eventIdsOf(received.map((message) => message.Body)).sort()).toEqual(eventIds);
      } finally {
        await killAll(running.splice(0));
        await events.destroy();
      }
    },
    60_000,
  );

  test("dois publishers em processos diferentes: cada evento publicado uma única vez", async () => {
    const events = await createTemporaryQueue("two-publishers");
    try {
      const { createWallet } = useCases(db.unitOfWork);
      const wallets = await Promise.all(Array.from({ length: 12 }, () => openWallet(createWallet)));
      const expected = (
        await Promise.all(wallets.map((wallet) => outboxIdsOfWallet(wallet.id)))
      ).flat();

      const env = { ...publisherEnv(events.name), ENABLE_HTTP: "false", OUTBOX_BATCH_SIZE: "3" };
      await Promise.all([start("publisher-a", env), start("publisher-b", env)]);
      await waitFor(async () => (await pendingOutbox()) === 0, {
        timeoutMs: 20_000,
        intervalMs: 100,
      });
      const received = await events.receive(expected.length, { settleMs: 1_500 });

      expect(eventIdsOf(received.map((message) => message.Body)).sort()).toEqual(
        [...expected].sort(),
      );
    } finally {
      await killAll(running.splice(0));
      await events.destroy();
    }
  }, 60_000);
});

describe("reinício do serviço no meio da carga", () => {
  test("instância morta durante a carga; o cliente reenvia tudo para a nova; estado final consistente", async () => {
    const events = await createTemporaryQueue("restart-events");
    try {
      const env = {
        ENABLE_OUTBOX_PUBLISHER: "true",
        ENABLE_PENDING_REFERENCE_WORKER: "true",
        SQS_EVENTS_QUEUE_NAME: events.name,
        // Reservas curtas: o que a instância morta tinha reservado volta em segundos.
        OUTBOX_LEASE_MS: "2000",
        OUTBOX_PUBLISH_TIMEOUT_MS: "1000",
        PENDING_REFERENCE_LEASE_MS: "2000",
      };
      const first = await start("before-restart", env);
      const wallets: Wallet[] = [];
      for (let i = 0; i < 6; i++) {
        const response = await first.request<Wallet>("POST", "/wallets", {
          body: { playerId: newId(), initialBalance: { amount: "100.00", currency: "BRL" } },
        });
        wallets.push(response.body);
      }
      // Por wallet: 4 apostas, 1 ganho e um REFUND enviado antes da BET que ele estorna.
      const operations = wallets.flatMap((wallet) => {
        const refundedBet = `bet-${newId()}`;
        const op = (kind: string, amount: string, extra: Record<string, unknown> = {}) => {
          const externalTransactionId = (extra.externalTransactionId as string) ?? `tx-${newId()}`;
          return {
            key: `provider-a:${externalTransactionId}`,
            body: {
              providerId: "provider-a",
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: "round-1",
              gameId: "fortune-chimp",
              kind,
              money: { amount, currency: "BRL" },
              ...extra,
              externalTransactionId,
            },
          };
        };
        return [
          op("REFUND", "10.00", { referenceExternalTransactionId: refundedBet }),
          op("BET", "5.00"),
          op("BET", "7.50"),
          op("WIN", "12.25"),
          op("BET", "2.75"),
          op("BET", "10.00", { externalTransactionId: refundedBet }),
        ];
      });
      const send = (instance: AppInstance, operation: (typeof operations)[number]) =>
        instance
          .request<{ status: string; idempotentReplay: boolean }>(
            "POST",
            "/wagering/transactions",
            {
              body: operation.body,
              headers: { "Idempotency-Key": operation.key },
            },
          )
          .catch(() => ({
            status: 0,
            body: { status: "CONNECTION_LOST", idempotentReplay: false },
          }));

      // Dispara toda a carga e mata a instância no meio dela: depois das primeiras respostas,
      // com o resto ainda em andamento.
      let answered = 0;
      const inFlight = Promise.all(
        operations.map((operation) =>
          send(first, operation).then((response) => {
            if (response.status !== 0) answered += 1;
            return response;
          }),
        ),
      );
      await waitFor(async () => answered >= 5, { timeoutMs: 10_000, intervalMs: 1 });
      await first.kill();
      const beforeCrash = await inFlight;

      // A nova instância recebe o reenvio de tudo (o cliente não sabe o que foi confirmado).
      const second = await start("after-restart", env);
      const retried = await Promise.all(operations.map((operation) => send(second, operation)));

      // A queda pegou a carga no meio: parte respondida e confirmada, parte perdida.
      expect(beforeCrash.filter((response) => response.status !== 0).length).toBeGreaterThanOrEqual(
        5,
      );
      expect(beforeCrash.some((response) => response.status === 0)).toBe(true);
      expect(retried.every((response) => [200, 202].includes(response.status))).toBe(true);
      // O que já tinha sido confirmado volta como replay, sem ser aplicado de novo.
      expect(
        retried.filter((response) => response.body.idempotentReplay).length,
      ).toBeGreaterThanOrEqual(5);
      // O worker resolve os REFUNDs pendentes, e o publisher esvazia a outbox.
      await waitFor(
        async () => {
          const [row] = await db.sql<{ count: number }[]>(
            "select count(*)::int as count from wager_transactions where status = 'PENDING_REFERENCE'",
          );
          return row?.count === 0 && (await pendingOutbox()) === 0;
        },
        { timeoutMs: 20_000, intervalMs: 100 },
      );
      for (const wallet of wallets) {
        // 100 - 5 - 7.50 + 12.25 - 2.75 - 10 + 10 (estorno) = 97.00, cada operação uma vez.
        expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
          balance: "97.00",
          debits: 4,
          credits: 3,
        });
      }
      const [transactions] = await db.sql<{ count: number }[]>(
        "select count(*)::int as count from wager_transactions where kind <> 'OPENING' and wallet_id in (?, ?, ?, ?, ?, ?)",
        wallets.map((wallet) => wallet.id),
      );
      expect(transactions?.count).toBe(operations.length);
    } finally {
      await killAll(running.splice(0));
      await events.destroy();
    }
  }, 90_000);
});

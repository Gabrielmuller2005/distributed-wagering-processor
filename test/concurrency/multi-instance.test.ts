import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { openTestDatabase, type TestDatabase } from "../helpers/database";
import { newId } from "../helpers/fixtures";
import { ensureTestQueue, testAppConfig } from "../helpers/http-app";
import { type AppInstance, killAll, spawnInstance } from "../helpers/instances";
import { expectLedgerMatchesWallet } from "../helpers/invariants";
import { createTemporaryQueue, waitFor } from "../helpers/sqs";

/**
 * Várias instâncias **reais** do serviço (`bun src/main.ts`, um processo e um pool de conexões
 * cada), apontando para o mesmo PostgreSQL e as mesmas filas. Nada é coordenado em memória: a
 * única coisa compartilhada é o banco, como em produção.
 */

let db: TestDatabase;
const running: AppInstance[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
  await ensureTestQueue(testAppConfig());
});

afterEach(async () => {
  await killAll(running.splice(0));
});

afterAll(async () => {
  await db.close();
});

async function start(count: number, overrides: Record<string, string> = {}) {
  const instances = await Promise.all(
    Array.from({ length: count }, (_, index) => spawnInstance(`instance-${index + 1}`, overrides)),
  );
  running.push(...instances);
  return instances;
}

interface Wallet {
  id: string;
  playerId: string;
}

async function createWallet(instance: AppInstance, amount: string): Promise<Wallet> {
  const response = await instance.request<Wallet>("POST", "/wallets", {
    body: { playerId: newId(), initialBalance: { amount, currency: "BRL" } },
  });
  expect(response.status).toBe(201);
  return response.body;
}

interface Submission {
  readonly key: string;
  readonly body: Record<string, unknown>;
}

function betOn(
  wallet: Wallet,
  amount: string,
  overrides: Record<string, unknown> = {},
): Submission {
  const externalTransactionId = (overrides.externalTransactionId as string) ?? `tx-${newId()}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: "provider-a",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount, currency: "BRL" },
      ...overrides,
      externalTransactionId,
    },
  };
}

function submitTo(instance: AppInstance, submission: Submission) {
  return instance.request<{ status: string; transactionId: string; idempotentReplay: boolean }>(
    "POST",
    "/wagering/transactions",
    { body: submission.body, headers: { "Idempotency-Key": submission.key } },
  );
}

/** Distribui as submissões entre as instâncias (round-robin) e dispara todas ao mesmo tempo. */
function spread(instances: readonly AppInstance[], submissions: readonly Submission[]) {
  return Promise.all(
    submissions.map((submission, index) =>
      submitTo(instances[index % instances.length] as AppInstance, submission),
    ),
  );
}

describe("três instâncias HTTP sobre o mesmo banco", () => {
  test("a mesma aposta enviada 50 vezes, espalhada entre as instâncias: um único débito", async () => {
    const instances = await start(3);
    const wallet = await createWallet(instances[0] as AppInstance, "100.00");
    const same = betOn(wallet, "10.00");

    const responses = await spread(
      instances,
      Array.from({ length: 50 }, () => same),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
      balance: "90.00",
      debits: 1,
    });
  }, 60_000);

  test("seção 8 entre processos: 80.00 + 80.00 sobre 100.00 em instâncias diferentes, 10 vezes", async () => {
    const instances = await start(3);

    for (let round = 0; round < 10; round++) {
      const wallet = await createWallet(instances[round % 3] as AppInstance, "100.00");
      const responses = await Promise.all([
        submitTo(instances[round % 3] as AppInstance, betOn(wallet, "80.00")),
        submitTo(instances[(round + 1) % 3] as AppInstance, betOn(wallet, "80.00")),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
      expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
        balance: "20.00",
        debits: 1,
      });
    }
  }, 60_000);

  test("30 apostas de 10.00 sobre 100.00 nas três instâncias: exatamente 10 passam", async () => {
    const instances = await start(3);
    const wallet = await createWallet(instances[0] as AppInstance, "100.00");

    const responses = await spread(
      instances,
      Array.from({ length: 30 }, () => betOn(wallet, "10.00")),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 422)).toHaveLength(20);
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
      balance: "0.00",
      debits: 10,
    });
  }, 60_000);

  test("wallets distintas em paralelo, cada uma tocada pelas três instâncias", async () => {
    const instances = await start(3);
    const wallets = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createWallet(instances[index % 3] as AppInstance, "100.00"),
      ),
    );
    const submissions = wallets.flatMap((wallet) => [
      betOn(wallet, "10.00"),
      betOn(wallet, "15.50"),
      betOn(wallet, "4.50", { kind: "WIN" }),
      betOn(wallet, "20.00"),
    ]);

    const responses = await spread(instances, submissions);

    expect(responses.every((response) => response.status === 200)).toBe(true);
    for (const wallet of wallets) {
      expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
        balance: "59.00",
        debits: 3,
        credits: 2,
      });
    }
  }, 60_000);
});

describe("três consumidores SQS sobre a mesma fila", () => {
  test("mensagens de várias wallets, com reenvios duplicados: cada operação aplicada uma vez", async () => {
    const queue = await createTemporaryQueue("multi-consumer");
    try {
      const [api] = await start(1);
      const wallets = await Promise.all(
        Array.from({ length: 4 }, () => createWallet(api as AppInstance, "100.00")),
      );
      await start(3, {
        ENABLE_HTTP: "false",
        ENABLE_SQS_CONSUMER: "true",
        SQS_QUEUE_NAME: queue.name,
        SQS_CONSUMER_BATCH_SIZE: "5",
      });

      const envelopes = wallets.flatMap((wallet) =>
        Array.from({ length: 8 }, () => {
          const externalTransactionId = `transaction-${newId()}`;
          return {
            wallet,
            body: JSON.stringify({
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
                money: { amount: "5.00", currency: "BRL" },
              },
            }),
          };
        }),
      );
      // Todas as mensagens, e um quarto delas de novo (o produtor reenviando).
      const sends = [...envelopes, ...envelopes.filter((_, index) => index % 4 === 0)];
      await Promise.all(
        sends.map((envelope) => queue.send(envelope.body, { groupId: envelope.wallet.id })),
      );

      await waitFor(
        async () => {
          const [row] = await db.sql<{ count: number }[]>(
            "select count(*)::int as count from inbox_messages",
          );
          return row?.count === envelopes.length;
        },
        { timeoutMs: 30_000, intervalMs: 200 },
      );
      // Uma rodada a mais para as duplicatas ainda em trânsito serem consumidas (como replay).
      await waitFor(async () => (await queue.receive(1, { timeoutMs: 1_500 })).length === 0, {
        timeoutMs: 15_000,
      });

      for (const wallet of wallets) {
        expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
          balance: "60.00",
          debits: 8,
        });
      }
    } finally {
      await killAll(running.splice(0));
      await queue.destroy();
    }
  }, 90_000);
});

describe("referência fora de ordem entre instâncias", () => {
  test("REFUND por uma instância, BET por outra, worker numa terceira: aplicado uma vez", async () => {
    const [first, second] = await start(2);
    await start(1, { ENABLE_HTTP: "false", ENABLE_PENDING_REFERENCE_WORKER: "true" });
    const wallet = await createWallet(first as AppInstance, "100.00");
    const betId = `bet-${newId()}`;

    const refund = await submitTo(
      first as AppInstance,
      betOn(wallet, "30.00", { kind: "REFUND", referenceExternalTransactionId: betId }),
    );
    const bet = await submitTo(
      second as AppInstance,
      betOn(wallet, "30.00", { externalTransactionId: betId }),
    );
    await waitFor(
      async () => {
        const response = await (first as AppInstance).request<{ status: string }>(
          "GET",
          `/wagering/transactions/${refund.body.transactionId}`,
        );
        return response.body.status === "PROCESSED";
      },
      { timeoutMs: 15_000, intervalMs: 100 },
    );

    expect(refund.status).toBe(202);
    expect(bet.status).toBe(200);
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
      balance: "100.00",
      debits: 1,
      credits: 2,
    });
  }, 60_000);
});

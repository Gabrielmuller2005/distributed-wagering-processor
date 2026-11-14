import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PendingReferenceWorker } from "../../../src/wagering/interface/workers/pending-reference.worker";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import {
  ensureTestQueue,
  startTestApp,
  type TestHttpApp,
  testAppConfig,
} from "../../helpers/http-app";
import { expectLedgerMatchesWallet } from "../../helpers/invariants";
import { waitFor } from "../../helpers/sqs";

let db: TestDatabase;

beforeAll(async () => {
  db = await openTestDatabase();
  await ensureTestQueue(testAppConfig());
});

afterAll(async () => {
  await db.close();
});

const workerConfig = (overrides: Record<string, string> = {}) =>
  testAppConfig({
    ENABLE_PENDING_REFERENCE_WORKER: "true",
    PENDING_REFERENCE_POLL_INTERVAL_MS: "50",
    ...overrides,
  });

async function createWallet(http: TestHttpApp) {
  const response = await http.request<{ id: string; playerId: string }>("POST", "/wallets", {
    body: { playerId: newId(), initialBalance: { amount: "100.00", currency: "BRL" } },
  });
  return response.body;
}

function submit(
  http: TestHttpApp,
  wallet: { id: string; playerId: string },
  fields: Record<string, unknown>,
) {
  const externalTransactionId = (fields.externalTransactionId as string) ?? `tx-${newId()}`;
  return http.request<{ transactionId: string; status: string }>("POST", "/wagering/transactions", {
    headers: { "Idempotency-Key": `provider-a:${externalTransactionId}` },
    body: {
      providerId: "provider-a",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      money: { amount: "30.00", currency: "BRL" },
      ...fields,
      externalTransactionId,
    },
  });
}

const statusOf = async (http: TestHttpApp, transactionId: string) =>
  (
    await http.request<{ status: string; failureCode: string | null }>(
      "GET",
      `/wagering/transactions/${transactionId}`,
    )
  ).body;

describe("papel ENABLE_PENDING_REFERENCE_WORKER", () => {
  test("REFUND antes da BET via HTTP: 202, e o worker aplica sozinho quando a BET chega", async () => {
    const http = await startTestApp(workerConfig());
    try {
      const wallet = await createWallet(http);
      const betId = `bet-${newId()}`;

      const refund = await submit(http, wallet, {
        kind: "REFUND",
        referenceExternalTransactionId: betId,
      });
      const bet = await submit(http, wallet, { kind: "BET", externalTransactionId: betId });
      await waitFor(
        async () => (await statusOf(http, refund.body.transactionId)).status === "PROCESSED",
      );

      expect(refund.status).toBe(202);
      expect(bet.status).toBe(200);
      expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
        balance: "100.00",
        debits: 1,
        credits: 2,
      });
      expect(http.app.get(PendingReferenceWorker).isRunning).toBe(true);
    } finally {
      await http.close();
    }
  });

  test("referência que nunca chega: rejeitada com REFERENCE_NOT_FOUND quando o prazo acaba", async () => {
    const http = await startTestApp(workerConfig({ PENDING_REFERENCE_TTL_MS: "1000" }));
    try {
      const wallet = await createWallet(http);

      const rollback = await submit(http, wallet, {
        kind: "ROLLBACK",
        referenceExternalTransactionId: `never-${newId()}`,
      });
      await waitFor(
        async () => (await statusOf(http, rollback.body.transactionId)).status === "REJECTED",
      );

      expect(await statusOf(http, rollback.body.transactionId)).toMatchObject({
        status: "REJECTED",
        failureCode: "REFERENCE_NOT_FOUND",
      });
    } finally {
      await http.close();
    }
  });

  test("com o papel desligado, a pendência continua pendente", async () => {
    const http = await startTestApp(workerConfig({ ENABLE_PENDING_REFERENCE_WORKER: "false" }));
    try {
      const wallet = await createWallet(http);
      const betId = `bet-${newId()}`;
      const refund = await submit(http, wallet, {
        kind: "REFUND",
        referenceExternalTransactionId: betId,
      });
      await submit(http, wallet, { kind: "BET", externalTransactionId: betId });
      await Bun.sleep(300);

      expect((await statusOf(http, refund.body.transactionId)).status).toBe("PENDING_REFERENCE");
      expect(http.app.get(PendingReferenceWorker).isRunning).toBe(false);
    } finally {
      await http.close();
    }
  });
});

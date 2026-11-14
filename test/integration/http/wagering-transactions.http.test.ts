import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import {
  ensureTestQueue,
  startTestApp,
  type TestHttpApp,
  testAppConfig,
} from "../../helpers/http-app";
import { expectLedgerMatchesWallet } from "../../helpers/invariants";

interface WalletBody {
  id: string;
  playerId: string;
}

interface ResultBody {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
  failureCode?: string;
}

let db: TestDatabase;
let http: TestHttpApp;

beforeAll(async () => {
  db = await openTestDatabase();
  const config = testAppConfig({ DB_LOCK_TIMEOUT_MS: "300" });
  await ensureTestQueue(config);
  http = await startTestApp(config);
});

afterAll(async () => {
  await http.close();
  await db.close();
});

async function createWallet(amount = "100.00"): Promise<WalletBody> {
  const response = await http.request<WalletBody>("POST", "/wallets", {
    body: { playerId: newId(), initialBalance: { amount, currency: "BRL" } },
  });
  return response.body;
}

function payload(wallet: WalletBody, overrides: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a",
    externalTransactionId: `tx-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

function submit(body: Record<string, unknown>, headers?: Record<string, string>) {
  return http.request<ResultBody>("POST", "/wagering/transactions", {
    body,
    headers: headers ?? {
      "Idempotency-Key": `${body.providerId}:${body.externalTransactionId}`,
    },
  });
}

describe("POST /wagering/transactions: mapeamento de status", () => {
  test("200 PROCESSED no formato do enunciado", async () => {
    const wallet = await createWallet("1000.00");

    const response = await submit(payload(wallet));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactionId: response.body.transactionId,
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
  });

  test("200 no replay, com idempotentReplay: true e o mesmo resultado", async () => {
    const wallet = await createWallet("100.00");
    const body = payload(wallet);
    const first = await submit(body);

    const replay = await submit(body);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).debits).toBe(1);
  });

  test("202 PENDING_REFERENCE quando a referência ainda não chegou", async () => {
    const wallet = await createWallet("100.00");

    const response = await submit(
      payload(wallet, { kind: "REFUND", referenceExternalTransactionId: "bet-not-arrived" }),
    );

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "PENDING_REFERENCE", balance: null });
  });

  test("422 REJECTED com transactionId e failureCode; replay da rejeição também é 422", async () => {
    const wallet = await createWallet("10.00");
    const body = payload(wallet, { money: { amount: "25.00", currency: "BRL" } });

    const response = await submit(body);
    const replay = await submit(body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      transactionId: response.body.transactionId,
      status: "REJECTED",
      balance: { amount: "10.00", currency: "BRL" },
      idempotentReplay: false,
      failureCode: "INSUFFICIENT_FUNDS",
      failureCategory: "FINAL",
    } as ResultBody);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("409 IDEMPOTENCY_CONFLICT: mesma chave, payload diferente", async () => {
    const wallet = await createWallet("100.00");
    const body = payload(wallet);
    const first = await submit(body);

    const response = await submit(
      { ...body, money: { amount: "26.00", currency: "BRL" } },
      { "Idempotency-Key": `${body.providerId}:${body.externalTransactionId}` },
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      details: { reason: "PAYLOAD_MISMATCH", existingTransactionId: first.body.transactionId },
    });
  });

  test("409 IDEMPOTENCY_CONFLICT: mesmo externalTransactionId com outra chave", async () => {
    const wallet = await createWallet("100.00");
    const body = payload(wallet);
    await submit(body);

    const response = await submit(body, { "Idempotency-Key": `other-${newId()}` });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { reason: "EXTERNAL_ID_REUSED" } });
  });

  test("400 IDEMPOTENCY_KEY_REQUIRED sem o header", async () => {
    const wallet = await createWallet("100.00");

    const response = await submit(payload(wallet), {});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  test.each([
    ["OPENING", { kind: "OPENING" }, "INVALID_KIND"],
    ["amount como número", { money: { amount: 25, currency: "BRL" } }, "INVALID_AMOUNT"],
    ["notação científica", { money: { amount: "1e2", currency: "BRL" } }, "INVALID_AMOUNT"],
    ["REFUND sem referência", { kind: "REFUND" }, "REFERENCE_REQUIRED"],
    ["sem roundId", { roundId: undefined }, "MISSING_FIELD"],
  ])("400 VALIDATION_ERROR: %s", async (_name, overrides, reason) => {
    const wallet = await createWallet("100.00");

    const response = await submit(payload(wallet, overrides));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "VALIDATION_ERROR", details: { reason } });
  });

  test("404 WALLET_NOT_FOUND e nada gravado", async () => {
    const wallet = await createWallet("100.00");
    const body = payload({ ...wallet, id: newId() });

    const response = await submit(body);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "WALLET_NOT_FOUND" });
    const rows = await db.sql<unknown[]>(
      "select 1 from wager_transactions where external_transaction_id = ?",
      [body.externalTransactionId],
    );
    expect(rows).toHaveLength(0);
  });

  test("503 TEMPORARILY_UNAVAILABLE com Retry-After quando o lock não sai a tempo; depois, a mesma requisição passa", async () => {
    const wallet = await createWallet("100.00");
    const body = payload(wallet);

    const holder = db.unitOfWork.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      await Bun.sleep(1_000);
    });
    await Bun.sleep(50);
    const blocked = await submit(body);
    await holder;
    const retried = await submit(body);

    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect(blocked.body).toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      details: { reason: "LOCK_TIMEOUT" },
    });
    expect(retried.status).toBe(200);
    expect(retried.body.idempotentReplay).toBe(false);
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).debits).toBe(1);
  });

  test("seção 8 via HTTP: duas apostas de 80.00 simultâneas sobre 100.00", async () => {
    const wallet = await createWallet("100.00");

    const responses = await Promise.all([
      submit(payload(wallet, { money: { amount: "80.00", currency: "BRL" } })),
      submit(payload(wallet, { money: { amount: "80.00", currency: "BRL" } })),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
      balance: "20.00",
      debits: 1,
    });
  });
});

describe("consultas de transação", () => {
  test("GET /wagering/transactions/:transactionId devolve a transação completa", async () => {
    const wallet = await createWallet("100.00");
    const body = payload(wallet);
    const created = await submit(body);

    const response = await http.request(
      "GET",
      `/wagering/transactions/${created.body.transactionId}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId: created.body.transactionId,
      providerId: "provider-a",
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.id,
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      status: "PROCESSED",
      balanceAfter: { amount: "75.00", currency: "BRL" },
      failureCode: null,
      referenceTransactionId: null,
    });
  });

  test("GET /providers/:providerId/wagering/transactions/:externalTransactionId", async () => {
    const wallet = await createWallet("10.00");
    const body = payload(wallet, { money: { amount: "50.00", currency: "BRL" } });
    const created = await submit(body);

    const response = await http.request(
      "GET",
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId: created.body.transactionId,
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      failureCategory: "FINAL",
    });
  });

  test.each([
    ["id inexistente", `/wagering/transactions/${newId()}`],
    ["id malformado", "/wagering/transactions/not-a-uuid"],
    ["id externo inexistente", "/providers/provider-a/wagering/transactions/nope"],
    ["outro provider", "/providers/provider-z/wagering/transactions/tx-1"],
  ])("404 TRANSACTION_NOT_FOUND: %s", async (_name, path) => {
    const response = await http.request("GET", path);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "TRANSACTION_NOT_FOUND" });
  });
});

describe("correlationId", () => {
  test("o correlationId da requisição chega aos eventos gravados na outbox", async () => {
    const wallet = await createWallet("100.00");
    const body = payload(wallet);

    const response = await submit(body, {
      "Idempotency-Key": `${body.providerId}:${body.externalTransactionId}`,
      "x-correlation-id": "corr-from-provider",
    });

    const rows = await db.sql<{ correlation: string }[]>(
      `select payload ->> 'correlationId' as correlation from outbox_messages
       where payload -> 'data' ->> 'transactionId' = ?`,
      [response.body.transactionId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.correlation === "corr-from-provider")).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import {
  ensureTestQueue,
  startTestApp,
  type TestHttpApp,
  testAppConfig,
} from "../../helpers/http-app";

interface WalletBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface LedgerBody {
  walletId: string;
  entries: { walletVersion: number; direction: string; money: { amount: string } }[];
  nextCursor: string | null;
}

let db: TestDatabase;
let http: TestHttpApp;

beforeAll(async () => {
  db = await openTestDatabase();
  const config = testAppConfig();
  await ensureTestQueue(config);
  http = await startTestApp(config);
});

afterAll(async () => {
  await http.close();
  await db.close();
});

const createWallet = (amount = "100.00", playerId = newId()) =>
  http.request<WalletBody>("POST", "/wallets", {
    body: { playerId, initialBalance: { amount, currency: "BRL" } },
  });

async function bet(walletId: string, playerId: string, amount: string) {
  const externalTransactionId = `tx-${newId()}`;
  return http.request("POST", "/wagering/transactions", {
    headers: { "Idempotency-Key": `provider-a:${externalTransactionId}` },
    body: {
      providerId: "provider-a",
      externalTransactionId,
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount, currency: "BRL" },
    },
  });
}

describe("POST /wallets", () => {
  test("201 com a wallet no formato do enunciado", async () => {
    const playerId = newId();

    const response = await createWallet("1000.00", playerId);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: response.body.id,
      playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
  });

  test("409 WALLET_ALREADY_EXISTS para o mesmo player e moeda", async () => {
    const playerId = newId();
    await createWallet("10.00", playerId);

    const response = await createWallet("20.00", playerId);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "WALLET_ALREADY_EXISTS",
      details: { playerId, currency: "BRL" },
    });
  });

  test.each([
    ["sem corpo", undefined],
    ["corpo como array", []],
    ["saldo negativo", { playerId: "p", initialBalance: { amount: "-1.00", currency: "BRL" } }],
    ["saldo como número", { playerId: "p", initialBalance: { amount: 10, currency: "BRL" } }],
    ["sem playerId", { initialBalance: { amount: "1.00", currency: "BRL" } }],
  ])("400 VALIDATION_ERROR: %s", async (_name, body) => {
    const response = await http.request("POST", "/wallets", { body });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("400 para JSON malformado", async () => {
    const response = await http.request("POST", "/wallets", { rawBody: '{"playerId": ' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { reason: "INVALID_JSON" },
    });
  });
});

describe("GET /wallets/:walletId", () => {
  test("200 com a wallet e o saldo atual", async () => {
    const created = await createWallet("100.00");
    await bet(created.body.id, created.body.playerId, "30.00");

    const response = await http.request<WalletBody>("GET", `/wallets/${created.body.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ balance: { amount: "70.00" }, version: 2 });
  });

  test.each([
    ["inexistente", newId()],
    ["com id malformado", "not-a-uuid"],
  ])("404 WALLET_NOT_FOUND para wallet %s", async (_name, walletId) => {
    const response = await http.request("GET", `/wallets/${walletId}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "WALLET_NOT_FOUND" });
  });
});

describe("GET /wallets/:walletId/ledger", () => {
  test("pagina com cursor opaco e estável, até o fim", async () => {
    const created = await createWallet("100.00");
    for (const amount of ["1.00", "2.00", "3.00", "4.00"]) {
      await bet(created.body.id, created.body.playerId, amount);
    }

    const pages: LedgerBody[] = [];
    let cursor: string | null = "";
    while (cursor !== null) {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const response = await http.request<LedgerBody>(
        "GET",
        `/wallets/${created.body.id}/ledger${query}`,
      );
      expect(response.status).toBe(200);
      pages.push(response.body);
      cursor = response.body.nextCursor;
    }

    expect(pages.map((page) => page.entries.map((entry) => entry.walletVersion))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(pages[0]?.entries[0]).toMatchObject({
      direction: "CREDIT",
      money: { amount: "100.00" },
    });
    expect(pages[0]?.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("limite padrão de 50", async () => {
    const created = await createWallet("100.00");

    const response = await http.request<LedgerBody>("GET", `/wallets/${created.body.id}/ledger`);

    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(1);
    expect(response.body.nextCursor).toBeNull();
  });

  test.each(["0", "201", "abc", "1.5", "-1"])("400 para limit inválido: %p", async (limit) => {
    const created = await createWallet("100.00");

    const response = await http.request("GET", `/wallets/${created.body.id}/ledger?limit=${limit}`);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { field: "limit" } });
  });

  test.each(["%%%", "bm90LWpzb24", Buffer.from('{"v":9,"after":1}').toString("base64url")])(
    "400 para cursor inválido: %p",
    async (cursor) => {
      const created = await createWallet("100.00");

      const response = await http.request(
        "GET",
        `/wallets/${created.body.id}/ledger?cursor=${encodeURIComponent(cursor)}`,
      );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ details: { field: "cursor" } });
    },
  );

  test("404 para wallet inexistente", async () => {
    expect((await http.request("GET", `/wallets/${newId()}/ledger`)).status).toBe(404);
  });
});

describe("POST /wallets/:walletId/reconciliation", () => {
  test("wallet consistente: saldo armazenado igual ao recalculado pelo ledger", async () => {
    const created = await createWallet("100.00");
    await bet(created.body.id, created.body.playerId, "30.10");

    const response = await http.request("POST", `/wallets/${created.body.id}/reconciliation`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: created.body.id,
      storedBalance: { amount: "69.90", currency: "BRL" },
      calculatedBalance: { amount: "69.90", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("divergência é detectada e sinalizada, sem correção silenciosa", async () => {
    const created = await createWallet("100.00");
    // Corrompe o saldo por fora, com os triggers desligados: o único jeito de produzir divergência.
    await db.sqlWithoutTriggers("update wallets set balance = 150 where id = ?", [created.body.id]);

    const response = await http.request("POST", `/wallets/${created.body.id}/reconciliation`);
    const after = await http.request<WalletBody>("GET", `/wallets/${created.body.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      storedBalance: { amount: "150.00" },
      calculatedBalance: { amount: "100.00" },
      difference: { amount: "50.00" },
      consistent: false,
      checkedEntries: 1,
    });
    expect(after.body.balance.amount).toBe("150.00");
  });

  test("404 para wallet inexistente", async () => {
    const response = await http.request("POST", `/wallets/${newId()}/reconciliation`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "WALLET_NOT_FOUND" });
  });
});

describe("transversal", () => {
  test("rota inexistente: 404 NOT_FOUND no formato padrão", async () => {
    const response = await http.request("GET", "/nope");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "NOT_FOUND" });
  });

  test("correlationId recebido volta no header; ausente, é gerado", async () => {
    const echoed = await http.request("GET", `/wallets/${newId()}`, {
      headers: { "x-correlation-id": "req-123" },
    });
    const generated = await http.request("GET", `/wallets/${newId()}`);
    const unsafe = await http.request("GET", `/wallets/${newId()}`, {
      headers: { "x-correlation-id": "bad value with spaces" },
    });

    expect(echoed.headers.get("x-correlation-id")).toBe("req-123");
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(unsafe.headers.get("x-correlation-id")).not.toBe("bad value with spaces");
  });
});

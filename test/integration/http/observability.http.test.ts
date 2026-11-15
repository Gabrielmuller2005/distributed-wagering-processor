import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createRootLogger, PinoLoggerService } from "../../../src/shared/observability/logger";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import {
  ensureTestQueue,
  startTestApp,
  type TestHttpApp,
  testAppConfig,
} from "../../helpers/http-app";

let db: TestDatabase;
let http: TestHttpApp;
const lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
  const config = testAppConfig({ DB_LOCK_TIMEOUT_MS: "300" });
  await ensureTestQueue(config);
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  http = await startTestApp(config, {
    logger: new PinoLoggerService(createRootLogger("info", stream)),
  });
});

afterAll(async () => {
  await http.close();
  await db.close();
});

/** A linha de log da requisição sai no "finish" da resposta: espera ela chegar. */
async function requestLine(predicate: (line: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 100; i++) {
    const found = lines.find((line) => line.msg === "request completed" && predicate(line));
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error("request log line not found");
}

async function createWallet(amount = "1000.00") {
  const response = await http.request<{ id: string; playerId: string }>("POST", "/wallets", {
    body: { playerId: newId(), initialBalance: { amount, currency: "BRL" } },
  });
  return response.body;
}

function bet(
  wallet: { id: string; playerId: string },
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const externalTransactionId = `tx-${newId()}`;
  const body = {
    providerId: "provider-obs",
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.37", currency: "BRL" },
    ...overrides,
  };
  return {
    body,
    send: () =>
      http.request<{ transactionId: string }>("POST", "/wagering/transactions", {
        body,
        headers: { "Idempotency-Key": `provider-obs:${externalTransactionId}`, ...headers },
      }),
  };
}

const metricsText = async () => {
  const response = await fetch(`${http.baseUrl}/metrics`);
  return { contentType: response.headers.get("content-type") ?? "", text: await response.text() };
};

function metricValue(text: string, series: string): number {
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${series} `));
  return line ? Number.parseFloat(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

describe("logs estruturados", () => {
  test("a linha da requisição traz correlationId, transactionId, walletId e providerId, sem valores", async () => {
    const wallet = await createWallet("1234.56");

    const response = await bet(wallet, {}, { "x-correlation-id": "corr-obs-1" }).send();
    const line = await requestLine((candidate) => candidate.correlationId === "corr-obs-1");

    expect(line).toMatchObject({
      level: "info",
      service: "distributed-wagering-processor",
      context: "Http",
      method: "POST",
      path: "/wagering/transactions",
      statusCode: 200,
      correlationId: "corr-obs-1",
      transactionId: response.body.transactionId,
      walletId: wallet.id,
      providerId: "provider-obs",
    });
    expect(typeof line.durationMs).toBe("number");
    // Nenhum valor financeiro (aposta nem saldo inicial) em linha nenhuma.
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain("25.37");
    expect(everything).not.toContain("1234.56");
  });

  test("a query string não vai para o log (cursores e filtros)", async () => {
    const wallet = await createWallet();

    await http.request("GET", `/wallets/${wallet.id}/ledger?limit=1&cursor=c2VjcmV0`);
    const line = await requestLine((candidate) => candidate.walletId === wallet.id);

    expect(line.path).toBe(`/wallets/${wallet.id}/ledger`);
    expect(JSON.stringify(lines)).not.toContain("c2VjcmV0");
  });

  test("health e metrics bem-sucedidos não poluem o nível info", async () => {
    await http.request("GET", "/health/live", { headers: { "x-correlation-id": "corr-live" } });
    await Bun.sleep(50);

    expect(lines.some((line) => line.correlationId === "corr-live")).toBe(false);
  });

  test("4xx sai como warn e 5xx como error", async () => {
    await http.request("GET", "/wallets/not-a-uuid", {
      headers: { "x-correlation-id": "corr-404" },
    });

    expect(await requestLine((candidate) => candidate.correlationId === "corr-404")).toMatchObject({
      level: "warn",
      statusCode: 404,
    });
  });
});

describe("GET /metrics", () => {
  test("formato Prometheus, aberto, com transações por status e duplicatas", async () => {
    const wallet = await createWallet();
    const request = bet(wallet);
    await request.send();
    await request.send(); // replay

    const { contentType, text } = await metricsText();

    expect(contentType).toContain("text/plain");
    expect(
      metricValue(
        text,
        'wagering_transactions_total{channel="http",status="PROCESSED",replay="false"}',
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(metricValue(text, 'wagering_duplicates_total{channel="http"}')).toBeGreaterThanOrEqual(
      1,
    );
    expect(text).toContain("wagering_processing_duration_seconds_bucket");
  });

  test("outbox lag: com o publisher desligado, a mensagem pendente mais antiga envelhece", async () => {
    await createWallet();
    await Bun.sleep(50);

    const { text } = await metricsText();

    expect(metricValue(text, "wagering_outbox_pending_messages")).toBeGreaterThan(0);
    expect(metricValue(text, "wagering_outbox_lag_seconds")).toBeGreaterThan(0);
  });

  test("transações esperando referência aparecem no gauge", async () => {
    const wallet = await createWallet();
    await bet(wallet, { kind: "REFUND", referenceExternalTransactionId: "never-arrives" }).send();

    const { text } = await metricsText();

    expect(metricValue(text, "wagering_pending_reference_transactions")).toBeGreaterThanOrEqual(1);
  });

  test("lock timeout (503) conta como conflito de lock", async () => {
    const wallet = await createWallet();
    const before = metricValue(
      (await metricsText()).text,
      'wagering_lock_conflicts_total{channel="http",reason="LOCK_TIMEOUT"}',
    );
    const holder = db.unitOfWork.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      await Bun.sleep(800);
    });
    await Bun.sleep(50);

    const blocked = await bet(wallet).send();
    await holder;
    const after = metricValue(
      (await metricsText()).text,
      'wagering_lock_conflicts_total{channel="http",reason="LOCK_TIMEOUT"}',
    );

    expect(blocked.status).toBe(503);
    expect(after - before).toBe(1);
  });

  test("reconciliação inconsistente: métrica e alerta no log, sem os saldos", async () => {
    const wallet = await createWallet("100.00");
    await db.sqlWithoutTriggers("update wallets set balance = 777.77 where id = ?", [wallet.id]);

    await http.request("POST", `/wallets/${wallet.id}/reconciliation`);
    const { text } = await metricsText();

    expect(metricValue(text, "wagering_reconciliation_inconsistencies_total")).toBe(1);
    const alert = lines.find(
      (line) => line.msg === "wallet balance is inconsistent with its ledger",
    );
    expect(alert).toMatchObject({ level: "warn", walletId: wallet.id, checkedEntries: 1 });
    expect(JSON.stringify(lines)).not.toContain("777.77");
  });
});

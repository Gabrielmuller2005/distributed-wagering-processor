import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import {
  ensureTestQueue,
  startTestApp,
  type TestHttpApp,
  testAppConfig,
} from "../../helpers/http-app";

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

describe("GET /health/live", () => {
  test("200: o processo está de pé, sem consultar dependências", async () => {
    const response = await http.request("GET", "/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("GET /health/ready", () => {
  test("200 com PostgreSQL e SQS alcançáveis", async () => {
    const response = await http.request("GET", "/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", checks: { database: "up", sqs: "up" } });
  });

  test("503 quando a fila SQS não existe, com o banco de pé", async () => {
    const app = await startTestApp(testAppConfig({ SQS_QUEUE_NAME: "does-not-exist.fifo" }));
    try {
      const response = await app.request("GET", "/health/ready");

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: "unavailable",
        checks: { database: "up", sqs: "down" },
      });
    } finally {
      await app.close();
    }
  });

  test("503 quando o PostgreSQL está inalcançável; liveness continua 200", async () => {
    const app = await startTestApp(
      testAppConfig({ DATABASE_URL: "postgres://wagering:wagering@127.0.0.1:1/wagering" }),
    );
    try {
      const ready = await app.request("GET", "/health/ready");
      const live = await app.request("GET", "/health/live");

      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({ checks: { database: "down", sqs: "up" } });
      expect(live.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

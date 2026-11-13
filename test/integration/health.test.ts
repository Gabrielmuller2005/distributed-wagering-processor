import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { createHttpApp } from "../../src/app";

describe("GET /health/live", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createHttpApp();
    app.useLogger(false);
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  test("responde 200 com status ok", async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

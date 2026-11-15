import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import {
  currentLogContext,
  enrichLogContext,
  runWithLogContext,
} from "../../../src/shared/observability/log-context";
import { createRootLogger, PinoLoggerService } from "../../../src/shared/observability/logger";

/** Destino em memória: cada linha JSON escrita pelo pino vira um objeto. */
function captureLines() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  return { lines, stream };
}

/** O pino escreve de forma síncrona num Writable comum, mas a escrita do stream é assíncrona. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("contexto de log", () => {
  test("fora de um contexto, é vazio e enrichLogContext não faz nada", () => {
    enrichLogContext({ walletId: "w-1" });

    expect(currentLogContext()).toEqual({});
  });

  test("o contexto atravessa awaits e é enriquecido conforme os ids aparecem", async () => {
    const seen = await runWithLogContext({ correlationId: "corr-1" }, async () => {
      await Bun.sleep(1);
      enrichLogContext({ walletId: "w-1" });
      await Promise.resolve();
      enrichLogContext({ transactionId: "t-1" });
      return { ...currentLogContext() };
    });

    expect(seen).toEqual({ correlationId: "corr-1", walletId: "w-1", transactionId: "t-1" });
  });

  test("contextos paralelos não se misturam", async () => {
    const run = (id: string) =>
      runWithLogContext({ correlationId: id }, async () => {
        await Bun.sleep(Math.random() * 5);
        enrichLogContext({ transactionId: `tx-${id}` });
        await Bun.sleep(Math.random() * 5);
        return { ...currentLogContext() };
      });

    const results = await Promise.all(["a", "b", "c", "d"].map(run));

    for (const [index, id] of ["a", "b", "c", "d"].entries()) {
      expect(results[index]).toEqual({ correlationId: id, transactionId: `tx-${id}` });
    }
  });

  test("só strings não vazias entram, truncadas em 128 caracteres", () => {
    const context = runWithLogContext({}, () => {
      enrichLogContext({
        walletId: 42,
        providerId: "",
        transactionId: { evil: true },
        messageId: "m".repeat(500),
      });
      return { ...currentLogContext() };
    });

    expect(context).toEqual({ messageId: "m".repeat(128) });
  });
});

describe("logger JSON", () => {
  test("uma linha JSON com nível, horário ISO, serviço, contexto do Nest e ids do contexto", async () => {
    const { lines, stream } = captureLines();
    const logger = new PinoLoggerService(createRootLogger("info", stream));

    runWithLogContext({ correlationId: "corr-1", walletId: "w-1" }, () => {
      logger.log({ msg: "wager transaction submitted", status: "PROCESSED" }, "Http");
    });
    await flush();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      service: "distributed-wagering-processor",
      context: "Http",
      msg: "wager transaction submitted",
      status: "PROCESSED",
      correlationId: "corr-1",
      walletId: "w-1",
    });
    expect(String(lines[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("redaction: valores financeiros, payloads, corpos e credenciais nunca saem", async () => {
    const { lines, stream } = captureLines();
    const logger = new PinoLoggerService(createRootLogger("info", stream));

    logger.warn({
      msg: "something odd",
      money: { amount: "25.00", currency: "BRL" },
      balance: "100.00",
      payload: { secret: true },
      request: {
        body: { amount: "99.00" },
        headers: { authorization: "Bearer token-123" },
      },
      walletId: "w-1",
    });
    await flush();

    const text = JSON.stringify(lines);
    expect(text).not.toContain("25.00");
    expect(text).not.toContain("100.00");
    expect(text).not.toContain("99.00");
    expect(text).not.toContain("token-123");
    expect(lines[0]).toMatchObject({ money: "[REDACTED]", walletId: "w-1" });
  });

  test("error do Nest leva a stack em campo próprio", async () => {
    const { lines, stream } = captureLines();
    const logger = new PinoLoggerService(createRootLogger("info", stream));

    logger.error("boom", "Error: boom\n    at somewhere", "HttpErrorFilter");
    await flush();

    expect(lines[0]).toMatchObject({
      level: "error",
      msg: "boom",
      context: "HttpErrorFilter",
      stack: "Error: boom\n    at somewhere",
    });
  });

  test("respeita o nível configurado", async () => {
    const { lines, stream } = captureLines();
    const logger = new PinoLoggerService(createRootLogger("warn", stream));

    logger.log("ignored");
    logger.debug("ignored");
    logger.warn("kept");
    await flush();

    expect(lines.map((line) => line.msg)).toEqual(["kept"]);
  });
});

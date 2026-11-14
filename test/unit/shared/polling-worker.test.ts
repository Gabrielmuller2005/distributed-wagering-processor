import { describe, expect, test } from "bun:test";
import { PollingWorker } from "../../../src/shared/application/polling-worker";

const silent = { warn: () => {} };

function worker(
  tick: () => Promise<boolean>,
  options: { idleDelayMs?: number; logger?: { warn(message: string): void } } = {},
) {
  return new PollingWorker(
    "test worker",
    tick,
    {
      idleDelayMs: options.idleDelayMs ?? 10_000,
      errorBackoff: { baseDelayMs: 20, maxDelayMs: 20 },
    },
    options.logger ?? silent,
    () => 0,
  );
}

/** Espera até a condição valer, com prazo curto: os testes não dependem de sleep fixo. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await Bun.sleep(5);
  }
}

describe("PollingWorker", () => {
  test("com trabalho sobrando, emenda ciclos; sem trabalho, espera o intervalo", async () => {
    let calls = 0;
    const subject = worker(async () => {
      calls += 1;
      return calls < 3;
    });

    subject.start();
    await until(() => calls === 3);
    await Bun.sleep(50);
    await subject.stop();

    // Ciclos 1 e 2 tinham mais trabalho; o 3 não tinha, e o intervalo (10 s) não venceu.
    expect(calls).toBe(3);
  });

  test("erro não derruba o worker: loga e tenta de novo com backoff", async () => {
    const warnings: string[] = [];
    let calls = 0;
    const subject = worker(
      async () => {
        calls += 1;
        if (calls <= 2) throw new Error("database down");
        return false;
      },
      { logger: { warn: (message) => warnings.push(message) } },
    );

    subject.start();
    await until(() => calls === 3);
    await subject.stop();

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("test worker cycle failed (1 in a row)");
    expect(warnings[1]).toContain("(2 in a row)");
    expect(warnings[1]).toContain("Error: database down");
  });

  test("stop interrompe a espera na hora", async () => {
    const subject = worker(async () => false, { idleDelayMs: 60_000 });
    subject.start();
    await Bun.sleep(20);

    const startedAt = Date.now();
    await subject.stop();

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(subject.isRunning).toBe(false);
  });

  test("stop aguarda o ciclo em andamento terminar e não começa outro", async () => {
    let calls = 0;
    let finished = false;
    let release: () => void = () => {};
    const subject = worker(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      finished = true;
      return true;
    });
    subject.start();
    await until(() => calls === 1);

    const stopping = subject.stop();
    await Bun.sleep(20);
    expect(finished).toBe(false);
    release();
    await stopping;

    expect(finished).toBe(true);
    expect(calls).toBe(1);
  });

  test("start duas vezes não cria dois laços", async () => {
    let calls = 0;
    const subject = worker(async () => {
      calls += 1;
      return false;
    });

    subject.start();
    subject.start();
    await until(() => calls >= 1);
    await Bun.sleep(30);
    await subject.stop();

    expect(calls).toBe(1);
  });
});

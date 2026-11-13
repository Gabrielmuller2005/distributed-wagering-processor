import { describe, expect, test } from "bun:test";
import { backoffDelayMs } from "../../../src/shared/domain/backoff";

const policy = { baseDelayMs: 1_000, maxDelayMs: 300_000 };
const ALMOST_ONE = 0.999_999;

describe("backoffDelayMs", () => {
  test.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [4, 8_000],
    [9, 256_000],
  ])("tentativa %p: atraso exponencial de %p ms com random no máximo", (attempt, exponential) => {
    expect(backoffDelayMs(attempt, policy, () => ALMOST_ONE)).toBe(exponential - 1);
  });

  test("com random zero, o atraso é metade do exponencial", () => {
    expect(backoffDelayMs(1, policy, () => 0)).toBe(500);
    expect(backoffDelayMs(3, policy, () => 0)).toBe(2_000);
  });

  test("o jitter fica sempre entre metade e o valor inteiro", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      for (const random of [0, 0.25, 0.5, 0.75, ALMOST_ONE]) {
        const delay = backoffDelayMs(attempt, policy, () => random);
        expect(delay).toBeGreaterThanOrEqual(exponential / 2);
        expect(delay).toBeLessThan(exponential);
      }
    }
  });

  test("respeita o teto, inclusive em tentativas muito altas", () => {
    expect(backoffDelayMs(10, policy, () => ALMOST_ONE)).toBe(299_999);
    expect(backoffDelayMs(1_000, policy, () => ALMOST_ONE)).toBe(299_999);
    expect(Number.isFinite(backoffDelayMs(1_000, policy))).toBe(true);
  });

  test.each([0, -1, 1.5, Number.NaN])("rejeita tentativa inválida: %p", (attempt) => {
    expect(() => backoffDelayMs(attempt, policy)).toThrow(RangeError);
  });
});

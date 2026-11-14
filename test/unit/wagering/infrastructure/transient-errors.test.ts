import { describe, expect, test } from "bun:test";
import { ConnectionException } from "@mikro-orm/core";
import { ConcurrentModificationError } from "../../../../src/wagering/application/errors";
import { transientReasonOf } from "../../../../src/wagering/infrastructure/persistence/transient-errors";

const withCode = (code: string): Error => Object.assign(new Error("db error"), { code });

describe("transientReasonOf", () => {
  test.each([
    ["55P03", "LOCK_TIMEOUT"],
    ["40P01", "DEADLOCK"],
    ["40001", "SERIALIZATION_FAILURE"],
    ["57P01", "DATABASE_UNAVAILABLE"],
    ["53300", "DATABASE_UNAVAILABLE"],
    ["08006", "DATABASE_UNAVAILABLE"],
    ["ECONNREFUSED", "DATABASE_UNAVAILABLE"],
  ] as const)("SQLSTATE/código %p é transitório: %p", (code, reason) => {
    expect(transientReasonOf(withCode(code))).toBe(reason);
  });

  test("ConcurrentModificationError é transitório", () => {
    expect(transientReasonOf(new ConcurrentModificationError("Wallet", "w-1"))).toBe(
      "CONCURRENT_MODIFICATION",
    );
  });

  test("ConnectionException do ORM é transitório", () => {
    expect(transientReasonOf(new ConnectionException(new Error("down")))).toBe(
      "DATABASE_UNAVAILABLE",
    );
  });

  test.each(["23505", "23514", "22P02", "42P01"])(
    "violação de integridade ou erro de sintaxe (%p) NÃO é transitório",
    (code) => {
      expect(transientReasonOf(withCode(code))).toBeUndefined();
    },
  );

  test.each([new Error("boom"), "string", undefined, { code: "55P03" }])(
    "erros sem código conhecido não são transitórios: %p",
    (error) => {
      expect(transientReasonOf(error)).toBeUndefined();
    },
  );
});

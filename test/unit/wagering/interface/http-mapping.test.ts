import { describe, expect, test } from "bun:test";
import { BadRequestException, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../../../src/wagering/application/errors";
import { WagerTransactionStatus as Status } from "../../../../src/wagering/domain/wager-transaction/wager-transaction-status";
import { toHttpError } from "../../../../src/wagering/interface/http/http-error-mapping";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseLedgerLimit,
} from "../../../../src/wagering/interface/http/ledger-cursor";
import { statusForResult } from "../../../../src/wagering/interface/http/wagering-transactions.controller";

describe("toHttpError: um código HTTP por situação, igual em todos os endpoints", () => {
  test.each([
    [new ValidationError("INVALID_AMOUNT", "money", "bad"), 400, "VALIDATION_ERROR"],
    [
      new ValidationError("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey", "x"),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    ],
    [new WalletNotFoundError("w"), 404, "WALLET_NOT_FOUND"],
    [new TransactionNotFoundError("t"), 404, "TRANSACTION_NOT_FOUND"],
    [new IdempotencyConflictError("PAYLOAD_MISMATCH", "t"), 409, "IDEMPOTENCY_CONFLICT"],
    [new WalletAlreadyExistsError("p", "BRL"), 409, "WALLET_ALREADY_EXISTS"],
    [new ConcurrentModificationError("Wallet", "w"), 503, "TEMPORARILY_UNAVAILABLE"],
    [Object.assign(new Error("lock"), { code: "55P03" }), 503, "TEMPORARILY_UNAVAILABLE"],
    [new BadRequestException(), 400, "VALIDATION_ERROR"],
    [new NotFoundException(), 404, "NOT_FOUND"],
    [new PayloadTooLargeException(), 413, "PAYLOAD_TOO_LARGE"],
  ])("%p → %p %p", (error, status, code) => {
    const mapped = toHttpError(error);

    expect(mapped.status).toBe(status);
    expect(mapped.body.code).toBe(code);
  });

  test("503 leva Retry-After", () => {
    expect(toHttpError(new ConcurrentModificationError("Wallet", "w")).headers).toEqual({
      "Retry-After": "1",
    });
  });

  test("erro inesperado vira 500 sem vazar a mensagem interna", () => {
    const mapped = toHttpError(new Error("connection string postgres://user:secret@db"));

    expect(mapped).toEqual({
      status: 500,
      body: { code: "INTERNAL_ERROR", message: "Unexpected error" },
      unexpected: true,
    });
  });
});

describe("statusForResult", () => {
  test.each([
    [Status.Processed, 200],
    [Status.PendingReference, 202],
    [Status.Rejected, 422],
    [Status.Failed, 500],
  ])("%p → %p", (status, code) => {
    expect(statusForResult(status)).toBe(code);
  });
});

describe("cursor do ledger", () => {
  test("ida e volta preserva a versão", () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(42))).toBe(42);
  });

  test("é opaco: base64url sem caracteres especiais", () => {
    expect(encodeLedgerCursor(7)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("ausente é a primeira página", () => {
    expect(decodeLedgerCursor(undefined)).toBeUndefined();
    expect(decodeLedgerCursor("")).toBeUndefined();
  });

  test.each(["***", "e30", ["a", "b"], Buffer.from('{"v":1,"after":-1}').toString("base64url")])(
    "cursor inválido é ValidationError: %p",
    (cursor) => {
      expect(() => decodeLedgerCursor(cursor)).toThrow(ValidationError);
    },
  );

  test("limit: padrão 50, máximo 200", () => {
    expect(parseLedgerLimit(undefined)).toBe(50);
    expect(parseLedgerLimit("200")).toBe(200);
    expect(() => parseLedgerLimit("201")).toThrow(ValidationError);
    expect(() => parseLedgerLimit(["10", "20"])).toThrow(ValidationError);
  });
});

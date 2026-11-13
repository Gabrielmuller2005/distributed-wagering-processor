import { describe, expect, test } from "bun:test";
import {
  FailureCategory,
  FailureCode,
  failureCategoryOf,
} from "../../../../src/wagering/domain/failure-code";
import { LedgerDirection } from "../../../../src/wagering/domain/ledger/ledger-direction";
import { Money } from "../../../../src/wagering/domain/money";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from "../../../../src/wagering/domain/wager-transaction/wager-transaction";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../../../src/wagering/domain/wager-transaction/wager-transaction.errors";
import { WagerTransactionKind as Kind } from "../../../../src/wagering/domain/wager-transaction/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../../../src/wagering/domain/wager-transaction/wager-transaction-status";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-01-01T00:00:01Z");

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: brl("25.00"),
    createdAt: T0,
    ...overrides,
  };
}

const bet = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(overrides));

function invalidReason(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof InvalidWagerTransactionError) return error.reason;
    throw error;
  }
  throw new Error("expected InvalidWagerTransactionError");
}

describe("WagerTransaction.create", () => {
  test("nasce em PENDING, sem resultado", () => {
    const tx = bet();

    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.balanceAfter).toBeUndefined();
  });

  test.each([
    "id",
    "providerId",
    "externalTransactionId",
    "idempotencyKey",
    "payloadHash",
    "walletId",
    "playerId",
    "roundId",
    "gameId",
  ] as const)("rejeita %s vazio", (field) => {
    expect(invalidReason(() => bet({ [field]: "  " }))).toBe("MISSING_FIELD");
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback, Kind.Opening])(
    "%s exige valor > 0",
    (kind) => {
      const reference = kind === Kind.Refund || kind === Kind.Rollback ? "ext-0" : undefined;

      expect(
        invalidReason(() =>
          bet({ kind, money: Money.zero("BRL"), referenceExternalTransactionId: reference }),
        ),
      ).toBe("INVALID_AMOUNT");
    },
  );

  test("LOSS aceita valor zero", () => {
    expect(bet({ kind: Kind.Loss, money: Money.zero("BRL") }).status).toBe(Status.Pending);
  });

  test("LOSS rejeita valor negativo", () => {
    expect(invalidReason(() => bet({ kind: Kind.Loss, money: brl("1.00").negate() }))).toBe(
      "INVALID_AMOUNT",
    );
  });

  test.each([Kind.Refund, Kind.Rollback])("%s exige referência", (kind) => {
    expect(invalidReason(() => bet({ kind }))).toBe("REFERENCE_REQUIRED");
    expect(invalidReason(() => bet({ kind, referenceExternalTransactionId: " " }))).toBe(
      "REFERENCE_REQUIRED",
    );
  });

  test.each([Kind.Bet, Kind.Opening])("%s não aceita referência", (kind) => {
    expect(invalidReason(() => bet({ kind, referenceExternalTransactionId: "ext-0" }))).toBe(
      "REFERENCE_NOT_ALLOWED",
    );
  });

  test.each([Kind.Win, Kind.Loss])("%s aceita referência opcional", (kind) => {
    expect(bet({ kind }).referenceExternalTransactionId).toBeUndefined();
    expect(
      bet({ kind, referenceExternalTransactionId: "ext-0" }).referenceExternalTransactionId,
    ).toBe("ext-0");
  });

  test("WIN com referência vazia é rejeitado", () => {
    expect(invalidReason(() => bet({ kind: Kind.Win, referenceExternalTransactionId: "" }))).toBe(
      "MISSING_FIELD",
    );
  });

  test("uma transação não pode referenciar a si mesma", () => {
    expect(
      invalidReason(() => bet({ kind: Kind.Refund, referenceExternalTransactionId: "ext-1" })),
    ).toBe("SELF_REFERENCE");
  });
});

describe("WagerTransaction: transições válidas", () => {
  test("PENDING -> PROCESSED guarda referência, saldo observado e horário", () => {
    const tx = bet();

    tx.markProcessed({ referenceTransactionId: "tx-0", balanceAfter: brl("75.00"), at: T1 });

    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.referenceTransactionId).toBe("tx-0");
    expect(tx.balanceAfter?.toString()).toBe("75.00");
    expect(tx.processedAt).toEqual(T1);
  });

  test("PENDING -> REJECTED guarda o código de falha", () => {
    const tx = bet();

    tx.reject(FailureCode.InsufficientFunds, { balanceAfter: brl("10.00"), at: T1 });

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.balanceAfter?.toString()).toBe("10.00");
    expect(tx.processedAt).toEqual(T1);
  });

  test("rejeição pode omitir o saldo (ex.: PLAYER_MISMATCH)", () => {
    const tx = bet();

    tx.reject(FailureCode.PlayerMismatch, { at: T1 });

    expect(tx.balanceAfter).toBeUndefined();
  });

  test("PENDING -> FAILED", () => {
    const tx = bet();

    tx.fail(FailureCode.InfrastructureFailure, T1);

    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InfrastructureFailure);
  });

  test.each([
    ["PROCESSED", (tx: WagerTransaction) => tx.markProcessed({ balanceAfter: brl("1"), at: T1 })],
    ["REJECTED", (tx: WagerTransaction) => tx.reject(FailureCode.ReferenceNotFound, { at: T1 })],
    ["FAILED", (tx: WagerTransaction) => tx.fail(FailureCode.InfrastructureFailure, T1)],
  ] as const)("PENDING -> PENDING_REFERENCE -> %s", (expected, finish) => {
    const tx = bet({ kind: Kind.Refund, referenceExternalTransactionId: "ext-0" });

    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);

    finish(tx);
    expect(tx.status).toBe(expected as Status);
  });
});

describe("WagerTransaction: estados terminais não transitam", () => {
  const terminalize = {
    PROCESSED: (tx: WagerTransaction) => tx.markProcessed({ balanceAfter: brl("1"), at: T1 }),
    REJECTED: (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, { at: T1 }),
    FAILED: (tx: WagerTransaction) => tx.fail(FailureCode.InfrastructureFailure, T1),
  };
  const attempts = {
    markProcessed: (tx: WagerTransaction) => tx.markProcessed({ balanceAfter: brl("2"), at: T1 }),
    markPendingReference: (tx: WagerTransaction) => tx.markPendingReference(),
    reject: (tx: WagerTransaction) => tx.reject(FailureCode.AlreadyReversed, { at: T1 }),
    fail: (tx: WagerTransaction) => tx.fail(FailureCode.InfrastructureFailure, T1),
  };

  for (const [terminal, toTerminal] of Object.entries(terminalize)) {
    for (const [attempt, run] of Object.entries(attempts)) {
      test(`${terminal} + ${attempt} lança InvalidTransactionStateError e não muda nada`, () => {
        const tx = bet();
        toTerminal(tx);
        const before = {
          status: tx.status,
          failureCode: tx.failureCode,
          balanceAfter: tx.balanceAfter?.toString(),
        };

        expect(() => run(tx)).toThrow(InvalidTransactionStateError);
        expect({
          status: tx.status,
          failureCode: tx.failureCode,
          balanceAfter: tx.balanceAfter?.toString(),
        }).toEqual(before);
      });
    }
  }

  test("PENDING_REFERENCE não volta para PENDING_REFERENCE", () => {
    const tx = bet({ kind: Kind.Refund, referenceExternalTransactionId: "ext-0" });
    tx.markPendingReference();

    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test("o erro informa a transação e a transição tentada", () => {
    const tx = bet();
    tx.fail(FailureCode.InfrastructureFailure, T1);

    try {
      tx.markProcessed({ balanceAfter: brl("1"), at: T1 });
      throw new Error("expected InvalidTransactionStateError");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidTransactionStateError);
      expect((error as InvalidTransactionStateError).from).toBe(Status.Failed);
      expect((error as InvalidTransactionStateError).to).toBe(Status.Processed);
      expect((error as Error).message).toContain("tx-1");
    }
  });
});

describe("WagerTransaction.rehydrate", () => {
  test("reconstrói estado terminal sem revalidar transições", () => {
    const tx = WagerTransaction.rehydrate({
      ...props(),
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balanceAfter: brl("20.00"),
      processedAt: T1,
    });

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
  });
});

describe("WagerTransaction: consultas", () => {
  test("affectsBalance é false só para LOSS", () => {
    expect(bet({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    expect(bet({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(bet({ kind: Kind.Win }).affectsBalance()).toBe(true);
  });

  test("requiresReference é true só para REFUND e ROLLBACK", () => {
    expect(bet({ kind: Kind.Bet }).requiresReference()).toBe(false);
    expect(bet({ kind: Kind.Win }).requiresReference()).toBe(false);
    expect(
      bet({ kind: Kind.Refund, referenceExternalTransactionId: "ext-0" }).requiresReference(),
    ).toBe(true);
    expect(
      bet({ kind: Kind.Rollback, referenceExternalTransactionId: "ext-0" }).requiresReference(),
    ).toBe(true);
  });

  test("matchesPayload compara o hash", () => {
    expect(bet().matchesPayload("hash-1")).toBe(true);
    expect(bet().matchesPayload("hash-2")).toBe(false);
  });
});

describe("WagerTransaction.ledgerDirectionFor (tabela da seção 7)", () => {
  const ref = (kind: Kind) =>
    bet({
      id: "tx-0",
      externalTransactionId: "ext-0",
      idempotencyKey: "k0",
      kind,
      referenceExternalTransactionId: kind === Kind.Refund ? "ext-bet" : undefined,
    });
  const rollback = () => bet({ kind: Kind.Rollback, referenceExternalTransactionId: "ext-0" });

  test("BET debita", () => {
    expect(bet({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  test.each([Kind.Win, Kind.Opening])("%s credita", (kind) => {
    expect(bet({ kind }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("REFUND credita", () => {
    expect(
      bet({ kind: Kind.Refund, referenceExternalTransactionId: "ext-0" }).ledgerDirectionFor(
        ref(Kind.Bet),
      ),
    ).toBe(LedgerDirection.Credit);
  });

  test("LOSS não gera lançamento", () => {
    expect(bet({ kind: Kind.Loss }).ledgerDirectionFor()).toBeUndefined();
  });

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])("ROLLBACK de %s faz o inverso: %s", (referenceKind, expected) => {
    expect(rollback().ledgerDirectionFor(ref(referenceKind))).toBe(expected);
  });

  test("ROLLBACK sem referência é erro de programação", () => {
    expect(() => rollback().ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Loss, Kind.Opening, Kind.Rollback])("ROLLBACK de %s é erro", (referenceKind) => {
    const reference =
      referenceKind === Kind.Rollback
        ? bet({
            id: "tx-0",
            externalTransactionId: "ext-0",
            kind: Kind.Rollback,
            referenceExternalTransactionId: "ext-x",
          })
        : ref(referenceKind);

    expect(() => rollback().ledgerDirectionFor(reference)).toThrow(InvalidWagerTransactionError);
  });
});

describe("FailureCode: taxonomia", () => {
  test("todo código tem categoria", () => {
    for (const code of Object.values(FailureCode)) {
      expect(Object.values(FailureCategory)).toContain(failureCategoryOf(code));
    }
  });

  test.each([
    [FailureCode.InsufficientFunds, FailureCategory.Final],
    [FailureCode.ReversalWouldOverdraw, FailureCategory.Final],
    [FailureCode.AlreadyReversed, FailureCategory.Final],
    [FailureCode.ReferenceMismatch, FailureCategory.FixPayload],
    [FailureCode.AmountMismatch, FailureCategory.FixPayload],
    [FailureCode.InfrastructureFailure, FailureCategory.Retryable],
  ])("%s é %s", (code, category) => {
    expect(failureCategoryOf(code)).toBe(category);
  });

  test("falta de saldo e reversão que estoura o saldo têm códigos distintos (regra 7.9)", () => {
    expect(FailureCode.InsufficientFunds).not.toBe(FailureCode.ReversalWouldOverdraw);
  });
});

import type { FailureCode } from "../failure-code";
import { invertDirection, LedgerDirection } from "../ledger/ledger-direction";
import { CurrencyMismatchError, type Money } from "../money";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "./wager-transaction.errors";
import { WagerTransactionKind } from "./wager-transaction-kind";
import {
  ALLOWED_TRANSITIONS,
  isTerminalStatus,
  WagerTransactionStatus,
} from "./wager-transaction-status";

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** id da referência no provedor (não o id interno). */
  readonly referenceExternalTransactionId?: string | undefined;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly processedAt?: Date | undefined;
  readonly balanceAfter?: Money | undefined;
}

export interface MarkProcessedProps {
  /** id interno da referência resolvida, quando houver. */
  readonly referenceTransactionId?: string | undefined;
  /** Saldo da wallet logo após aplicar a transação (para o replay devolver o mesmo saldo). */
  readonly balanceAfter: Money;
  readonly at: Date;
}

export interface RejectProps {
  readonly referenceTransactionId?: string | undefined;
  /**
   * Saldo observado no momento da rejeição, na moeda da transação. Opcional: em PLAYER_MISMATCH
   * ele vazaria o saldo de outro player, e em CURRENCY_MISMATCH está em outra moeda.
   */
  readonly balanceAfter?: Money | undefined;
  readonly at: Date;
}

const KINDS_REQUIRING_REFERENCE = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** BET e OPENING não referenciam nada. WIN e LOSS podem referenciar a BET da rodada. */
const KINDS_FORBIDDING_REFERENCE = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Opening,
]);

/** Tipos que um ROLLBACK pode reverter; a direção do ROLLBACK é a inversa da deles. */
const ROLLBACKABLE_KINDS = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

/**
 * Transação de aposta. Nasce em PENDING e evolui pela máquina de estados de
 * `ALLOWED_TRANSITIONS`. Estados terminais (PROCESSED, REJECTED, FAILED) não mudam mais:
 * qualquer tentativa lança InvalidTransactionStateError.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _balanceAfter: Money | undefined,
  ) {}

  /** Cria em PENDING, validando campos obrigatórios, valor e exigência de referência por tipo. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.validate(props);
    return WagerTransaction.build({ ...props, status: WagerTransactionStatus.Pending });
  }

  /** Reconstrução a partir da persistência: não revalida regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return WagerTransaction.build(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Momento em que a transação chegou a um estado terminal. */
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** Saldo observado quando a transação terminou; é o saldo devolvido nos replays. */
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  // ---- transições

  markProcessed(props: MarkProcessedProps): void {
    this.assertBalanceCurrency(props.balanceAfter);
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = props.referenceTransactionId;
    this._balanceAfter = props.balanceAfter;
    this._processedAt = props.at;
  }

  markPendingReference(): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
  }

  reject(code: FailureCode, props: RejectProps): void {
    this.assertBalanceCurrency(props.balanceAfter);
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._referenceTransactionId = props.referenceTransactionId;
    this._balanceAfter = props.balanceAfter;
    this._processedAt = props.at;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return isTerminalStatus(this._status);
  }

  /** LOSS registra o resultado da rodada sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  /** Mesma idempotency key com hash diferente é conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger: BET debita; OPENING, WIN e REFUND creditam;
   * ROLLBACK faz o inverso da referência; LOSS não gera lançamento (undefined).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        if (!reference || !ROLLBACKABLE_KINDS.has(reference.kind)) {
          throw new InvalidWagerTransactionError(
            "REFERENCE_REQUIRED",
            `ROLLBACK ${this.id} needs a BET, WIN or REFUND reference to define its direction`,
          );
        }
        const referenceDirection = reference.ledgerDirectionFor();
        if (!referenceDirection) {
          throw new InvalidWagerTransactionError(
            "REFERENCE_REQUIRED",
            `ROLLBACK ${this.id} references a transaction without ledger effect`,
          );
        }
        return invertDirection(referenceDirection);
      }
    }
  }

  /** O saldo registrado na transação está sempre na moeda dela (é assim que é persistido). */
  private assertBalanceCurrency(balance: Money | undefined): void {
    if (balance && balance.currency !== this.money.currency) {
      throw new CurrencyMismatchError(this.money.currency, balance.currency);
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
  }

  private static validate(props: CreateWagerTransactionProps): void {
    const required = [
      "id",
      "providerId",
      "externalTransactionId",
      "idempotencyKey",
      "payloadHash",
      "walletId",
      "playerId",
      "roundId",
      "gameId",
    ] as const;
    for (const field of required) {
      if (props[field].trim() === "") {
        throw new InvalidWagerTransactionError("MISSING_FIELD", `${field} must not be empty`);
      }
    }

    const amountIsValid =
      props.kind === WagerTransactionKind.Loss
        ? !props.money.isNegative()
        : props.money.isPositive();
    if (!amountIsValid) {
      throw new InvalidWagerTransactionError(
        "INVALID_AMOUNT",
        `${props.kind} amount must be ${props.kind === WagerTransactionKind.Loss ? ">= 0" : "> 0"}, got ${props.money.toString()}`,
      );
    }

    const reference = props.referenceExternalTransactionId;
    const hasReference = reference !== undefined && reference.trim() !== "";

    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && !hasReference) {
      throw new InvalidWagerTransactionError(
        "REFERENCE_REQUIRED",
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (KINDS_FORBIDDING_REFERENCE.has(props.kind) && reference !== undefined) {
      throw new InvalidWagerTransactionError(
        "REFERENCE_NOT_ALLOWED",
        `${props.kind} must not have referenceExternalTransactionId`,
      );
    }
    if (reference !== undefined && !hasReference) {
      throw new InvalidWagerTransactionError(
        "MISSING_FIELD",
        "referenceExternalTransactionId must not be empty when present",
      );
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(
        "SELF_REFERENCE",
        "a transaction cannot reference itself",
      );
    }
  }

  private static build(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
    );
  }
}

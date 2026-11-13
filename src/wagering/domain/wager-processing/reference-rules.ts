import { FailureCode } from "../failure-code";
import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import { WagerTransactionKind as Kind } from "../wager-transaction/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../wager-transaction/wager-transaction-status";
import type { Wallet } from "../wallet/wallet";

/** Tipos que cada operação pode referenciar (seção 7, regra 3). */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<Kind, ReadonlySet<Kind>>>> = {
  [Kind.Refund]: new Set([Kind.Bet]),
  [Kind.Rollback]: new Set([Kind.Bet, Kind.Win, Kind.Refund]),
  // WIN e LOSS podem, opcionalmente, apontar a BET da mesma rodada.
  [Kind.Win]: new Set([Kind.Bet]),
  [Kind.Loss]: new Set([Kind.Bet]),
};

const REVERSAL_KINDS: ReadonlySet<Kind> = new Set([Kind.Refund, Kind.Rollback]);

export function isReversal(transaction: WagerTransaction): boolean {
  return REVERSAL_KINDS.has(transaction.kind);
}

export type ReferenceDecision =
  | { readonly outcome: "ACCEPTED" }
  | { readonly outcome: "PENDING" }
  | { readonly outcome: "REJECTED"; readonly code: FailureCode };

export interface ReferenceContext {
  /** Referência resolvida por (providerId, referenceExternalTransactionId); undefined se não existe. */
  readonly reference: WagerTransaction | undefined;
  /** Se a referência já tem um REFUND ou ROLLBACK PROCESSED. */
  readonly referenceAlreadyReversed: boolean;
}

/**
 * Avalia a referência de uma transação. Ordem das verificações:
 *
 * 1. sem referência informada (WIN/LOSS sem referência) → aceita;
 * 2. referência inexistente → pendente (pode chegar fora de ordem);
 * 3. tipo de referência não permitido → INVALID_REFERENCE_KIND;
 * 4. outro provider, player, wallet, moeda ou rodada → REFERENCE_MISMATCH;
 * 5. reversão com valor diferente → AMOUNT_MISMATCH;
 * 6. referência ainda não terminal → pendente; REJECTED ou FAILED → REFERENCE_NOT_PROCESSED;
 * 7. reversão de algo já revertido → ALREADY_REVERSED.
 *
 * As verificações 3 a 5 vêm antes do status de propósito: são problemas que nunca se resolvem
 * esperando, então a transação é rejeitada na hora em vez de ficar pendente à toa.
 */
export function evaluateReference(
  transaction: WagerTransaction,
  context: ReferenceContext,
): ReferenceDecision {
  if (transaction.referenceExternalTransactionId === undefined) return { outcome: "ACCEPTED" };

  const { reference } = context;
  if (!reference) return { outcome: "PENDING" };

  if (!ALLOWED_REFERENCE_KINDS[transaction.kind]?.has(reference.kind)) {
    return { outcome: "REJECTED", code: FailureCode.InvalidReferenceKind };
  }

  const sameOwner =
    reference.providerId === transaction.providerId &&
    reference.externalTransactionId === transaction.referenceExternalTransactionId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId;
  if (!sameOwner) return { outcome: "REJECTED", code: FailureCode.ReferenceMismatch };

  if (isReversal(transaction) && !reference.money.equals(transaction.money)) {
    return { outcome: "REJECTED", code: FailureCode.AmountMismatch };
  }

  if (reference.status === Status.Pending || reference.status === Status.PendingReference) {
    return { outcome: "PENDING" };
  }
  if (reference.status !== Status.Processed) {
    return { outcome: "REJECTED", code: FailureCode.ReferenceNotProcessed };
  }

  if (isReversal(transaction) && context.referenceAlreadyReversed) {
    return { outcome: "REJECTED", code: FailureCode.AlreadyReversed };
  }

  return { outcome: "ACCEPTED" };
}

/**
 * A transação pertence à wallet informada? Player diferente → PLAYER_MISMATCH;
 * moeda diferente → CURRENCY_MISMATCH. undefined quando está tudo certo.
 */
export function evaluateWalletOwnership(
  transaction: WagerTransaction,
  wallet: Wallet,
): FailureCode | undefined {
  if (transaction.playerId !== wallet.playerId) return FailureCode.PlayerMismatch;
  if (transaction.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch;
  return undefined;
}

/**
 * Código para um débito que não cabe no saldo. Uma BET sem saldo e uma reversão que estouraria
 * o saldo (ROLLBACK de WIN ou de REFUND) são situações operacionais diferentes (seção 7, regra 9).
 */
export function debitRejectionCode(transaction: WagerTransaction): FailureCode {
  return transaction.kind === Kind.Rollback
    ? FailureCode.ReversalWouldOverdraw
    : FailureCode.InsufficientFunds;
}

import { DomainError } from "../../../shared/domain/domain-error";
import type { MoneyProps } from "../money";
import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import type { WagerTransactionKind } from "../wager-transaction/wager-transaction-kind";
import type { WagerTransactionStatus } from "../wager-transaction/wager-transaction-status";

/** Evento criado a partir de uma transação no estado errado (erro de programação). */
export class InvalidEventSourceError extends DomainError {
  readonly code = "INVALID_EVENT_SOURCE";

  constructor(eventType: string, transaction: WagerTransaction, expected: WagerTransactionStatus) {
    super(
      `${eventType} requires a ${expected} transaction, but ${transaction.id} is ${transaction.status}`,
    );
  }
}

/** Identificação da transação, comum aos eventos de transação. */
export interface TransactionEventData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
}

export function transactionEventData(transaction: WagerTransaction): TransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

export function assertStatus(
  eventType: string,
  transaction: WagerTransaction,
  expected: WagerTransactionStatus,
): void {
  if (transaction.status !== expected) {
    throw new InvalidEventSourceError(eventType, transaction, expected);
  }
}

/** Data obrigatória de um estado terminal; ausente indica estado inconsistente. */
export function requireDate(eventType: string, transaction: WagerTransaction): string {
  const at = transaction.processedAt;
  if (!at) throw new InvalidEventSourceError(eventType, transaction, transaction.status);
  return at.toISOString();
}

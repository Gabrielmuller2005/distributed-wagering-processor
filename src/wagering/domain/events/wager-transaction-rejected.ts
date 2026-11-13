import { type FailureCategory, type FailureCode, failureCategoryOf } from "../failure-code";
import type { MoneyProps } from "../money";
import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import { WagerTransactionStatus } from "../wager-transaction/wager-transaction-status";
import { type EventContext, IntegrationEvent } from "./integration-event";
import {
  assertStatus,
  InvalidEventSourceError,
  requireDate,
  type TransactionEventData,
  transactionEventData,
} from "./transaction-event-data";

export interface WagerTransactionRejectedData extends TransactionEventData {
  readonly failureCode: FailureCode;
  /** Diz ao consumidor se vale corrigir, desistir ou tentar de novo. */
  readonly failureCategory: FailureCategory;
  readonly referenceTransactionId: string | null;
  /** null quando o saldo não pode ser exposto (ex.: PLAYER_MISMATCH). */
  readonly balanceAfter: MoneyProps | null;
  readonly rejectedAt: string;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  static readonly EVENT_TYPE = "WagerTransactionRejected";
  readonly eventType = WagerTransactionRejected.EVENT_TYPE;
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const type = WagerTransactionRejected.EVENT_TYPE;
    assertStatus(type, transaction, WagerTransactionStatus.Rejected);
    const failureCode = transaction.failureCode;
    if (!failureCode) {
      throw new InvalidEventSourceError(type, transaction, WagerTransactionStatus.Rejected);
    }

    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionEventData(transaction),
        failureCode,
        failureCategory: failureCategoryOf(failureCode),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balanceAfter: transaction.balanceAfter?.toJSON() ?? null,
        rejectedAt: requireDate(type, transaction),
      },
    });
  }
}

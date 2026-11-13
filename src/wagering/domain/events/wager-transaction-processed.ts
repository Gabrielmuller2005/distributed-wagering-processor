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

export interface WagerTransactionProcessedData extends TransactionEventData {
  readonly referenceTransactionId: string | null;
  readonly balanceAfter: MoneyProps;
  readonly processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  static readonly EVENT_TYPE = "WagerTransactionProcessed";
  readonly eventType = WagerTransactionProcessed.EVENT_TYPE;
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    const type = WagerTransactionProcessed.EVENT_TYPE;
    assertStatus(type, transaction, WagerTransactionStatus.Processed);
    const balanceAfter = transaction.balanceAfter;
    if (!balanceAfter) {
      throw new InvalidEventSourceError(type, transaction, WagerTransactionStatus.Processed);
    }

    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionEventData(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balanceAfter: balanceAfter.toJSON(),
        processedAt: requireDate(type, transaction),
      },
    });
  }
}

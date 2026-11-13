import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import { WagerTransactionStatus } from "../wager-transaction/wager-transaction-status";
import { type EventContext, IntegrationEvent } from "./integration-event";
import {
  assertStatus,
  InvalidEventSourceError,
  type TransactionEventData,
  transactionEventData,
} from "./transaction-event-data";

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  /** id, no provedor, da referência que ainda não chegou. */
  readonly referenceExternalTransactionId: string;
}

/** Transação aceita, aguardando a transação referenciada. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  static readonly EVENT_TYPE = "WagerTransactionPendingReference";
  readonly eventType = WagerTransactionPendingReference.EVENT_TYPE;
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    const type = WagerTransactionPendingReference.EVENT_TYPE;
    assertStatus(type, transaction, WagerTransactionStatus.PendingReference);
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    if (referenceExternalTransactionId === undefined) {
      throw new InvalidEventSourceError(type, transaction, WagerTransactionStatus.PendingReference);
    }

    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: { ...transactionEventData(transaction), referenceExternalTransactionId },
    });
  }
}

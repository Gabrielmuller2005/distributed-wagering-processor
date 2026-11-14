import type { IdGenerator } from "../../shared/application/id-generator";
import type { EventContext, IntegrationEvent } from "../domain/events/integration-event";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import type { WagerTransaction } from "../domain/wager-transaction/wager-transaction";
import { WagerTransactionStatus } from "../domain/wager-transaction/wager-transaction-status";
import type { Wallet } from "../domain/wallet/wallet";

export interface EventMetadata {
  readonly correlationId: string;
  readonly causationId?: string | undefined;
}

export interface OutcomeEventsInput {
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  readonly ledgerEntry: WalletLedgerEntry | undefined;
  readonly metadata: EventMetadata;
  readonly ids: IdGenerator;
  readonly at: Date;
}

/**
 * Eventos de integração de um resultado, já embrulhados como mensagens da outbox, para serem
 * gravados na **mesma transação SQL** da mudança financeira:
 *
 * - PROCESSED → WagerTransactionProcessed (+ WalletBalanceChanged se houve lançamento);
 * - REJECTED → WagerTransactionRejected;
 * - PENDING_REFERENCE → WagerTransactionPendingReference.
 */
export function outcomeOutboxMessages(input: OutcomeEventsInput): OutboxMessage[] {
  const context = (): EventContext => ({
    eventId: input.ids.next(),
    correlationId: input.metadata.correlationId,
    causationId: input.metadata.causationId,
    occurredAt: input.at,
  });
  const { transaction } = input;
  const events: IntegrationEvent<unknown>[] = [];

  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(transaction, context()));
      if (input.ledgerEntry) {
        events.push(WalletBalanceChanged.from(input.wallet, input.ledgerEntry, context()));
      }
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(transaction, context()));
      break;
    case WagerTransactionStatus.PendingReference:
      events.push(WagerTransactionPendingReference.from(transaction, context()));
      break;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.Failed:
      break;
  }

  return events.map((event) => OutboxMessage.enqueue(event));
}

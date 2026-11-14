import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import {
  applyWagerTransaction,
  type WagerOutcome,
} from "../domain/wager-processing/apply-wager-transaction";
import type { WagerTransaction } from "../domain/wager-transaction/wager-transaction";
import { WagerTransactionStatus } from "../domain/wager-transaction/wager-transaction-status";
import type { Wallet } from "../domain/wallet/wallet";
import type { TransactionalRepositories } from "./ports/repositories";

export interface ApplyAndRecordInput {
  readonly repositories: TransactionalRepositories;
  readonly transaction: WagerTransaction;
  /** A wallet da transação, já travada com FOR UPDATE nesta mesma transação SQL. */
  readonly wallet: Wallet;
  readonly ledgerEntryId: string;
  readonly at: Date;
}

export interface AppliedTransaction {
  readonly outcome: WagerOutcome;
  readonly ledgerEntry: WalletLedgerEntry | undefined;
}

/**
 * O núcleo comum à submissão (HTTP e SQS) e ao worker de PENDING_REFERENCE: resolve a
 * referência, aplica as regras do domínio e grava o que mudou de saldo (wallet com
 * `UPDATE ... WHERE version` e o lançamento no ledger).
 *
 * Quem chama grava o resultado da transação e os eventos, porque isso difere entre os dois
 * caminhos (ex.: uma PENDING_REFERENCE que continua pendente não gera evento novo).
 *
 * Quando a transação termina, as PENDING_REFERENCE que esperavam por ela são antecipadas: o
 * REFUND que chegou antes da BET é reprocessado logo depois de a BET chegar, sem esperar o
 * backoff inteiro.
 */
export async function applyAndRecord(input: ApplyAndRecordInput): Promise<AppliedTransaction> {
  const { repositories, transaction, wallet, at } = input;

  const referenceExternalId = transaction.referenceExternalTransactionId;
  const reference =
    referenceExternalId === undefined
      ? undefined
      : await repositories.transactions.findByProviderAndExternalId(
          transaction.providerId,
          referenceExternalId,
        );
  const referenceAlreadyReversed = reference
    ? await repositories.transactions.hasProcessedReversal(reference.id)
    : false;

  const expectedVersion = wallet.version;
  const outcome = applyWagerTransaction({
    transaction,
    wallet,
    reference,
    referenceAlreadyReversed,
    ledgerEntryId: input.ledgerEntryId,
    at,
  });

  const ledgerEntry =
    outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
  if (ledgerEntry) {
    await repositories.wallets.saveBalance(wallet, expectedVersion);
    await repositories.ledger.append(ledgerEntry);
  }

  if (transaction.isTerminal()) {
    await repositories.transactions.expediteReferenceRetries(
      transaction.providerId,
      transaction.externalTransactionId,
      at,
    );
  }

  return { outcome, ledgerEntry };
}

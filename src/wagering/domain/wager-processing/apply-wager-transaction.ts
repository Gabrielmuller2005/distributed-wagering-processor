import { DomainError } from "../../../shared/domain/domain-error";
import { FailureCode } from "../failure-code";
import { LedgerDirection } from "../ledger/ledger-direction";
import { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import { WagerTransactionStatus as Status } from "../wager-transaction/wager-transaction-status";
import type { Wallet } from "../wallet/wallet";
import {
  debitRejectionCode,
  evaluateReference,
  evaluateWalletOwnership,
  type ReferenceContext,
} from "./reference-rules";

/** Chamada com dados que nunca deveriam se encontrar (erro de programação, não de negócio). */
export class InvalidWagerApplicationError extends DomainError {
  readonly code = "INVALID_WAGER_APPLICATION";

  constructor(reason: string) {
    super(`Cannot apply wager transaction: ${reason}`);
  }
}

export interface ApplyWagerTransactionInput extends ReferenceContext {
  readonly transaction: WagerTransaction;
  /** Wallet da transação, já travada (FOR UPDATE) pela camada de aplicação. */
  readonly wallet: Wallet;
  /** id do lançamento a criar, se a transação mover saldo. */
  readonly ledgerEntryId: string;
  readonly at: Date;
}

export type WagerOutcome =
  | { readonly status: Status.Processed; readonly ledgerEntry: WalletLedgerEntry | undefined }
  | { readonly status: Status.Rejected; readonly failureCode: FailureCode }
  | { readonly status: Status.PendingReference };

/**
 * Aplica as regras de negócio (seção 7) a uma transação PENDING ou PENDING_REFERENCE.
 *
 * Função pura de domínio: altera apenas a transação e a wallet recebidas e devolve o resultado,
 * incluindo o lançamento do ledger quando há movimentação. Quem chama persiste tudo na mesma
 * transação SQL. A rejeição de negócio é um resultado (REJECTED + failureCode), não uma exceção.
 */
export function applyWagerTransaction(input: ApplyWagerTransactionInput): WagerOutcome {
  const { transaction, wallet, reference, at } = input;

  // Verificado antes de tudo: sem isso, a wallet seria movimentada e só depois a transição
  // falharia, deixando o saldo alterado para uma transação que já tinha terminado.
  if (transaction.isTerminal()) {
    throw new InvalidWagerApplicationError(
      `transaction ${transaction.id} is already ${transaction.status}`,
    );
  }

  if (transaction.walletId !== wallet.id) {
    throw new InvalidWagerApplicationError(
      `transaction ${transaction.id} belongs to wallet ${transaction.walletId}, not ${wallet.id}`,
    );
  }

  const ownershipFailure = evaluateWalletOwnership(transaction, wallet);
  if (ownershipFailure) {
    // O saldo da wallet não é registrado nestas rejeições:
    // - PLAYER_MISMATCH: a wallet é de outro player, e o saldo dela não pode vazar;
    // - CURRENCY_MISMATCH: o saldo está em outra moeda e não cabe no balanceAfter da transação.
    transaction.reject(ownershipFailure, { at });
    return { status: Status.Rejected, failureCode: ownershipFailure };
  }

  const decision = evaluateReference(transaction, input);
  if (decision.outcome === "PENDING") {
    if (transaction.status === Status.Pending) transaction.markPendingReference();
    return { status: Status.PendingReference };
  }
  if (decision.outcome === "REJECTED") {
    transaction.reject(decision.code, {
      referenceTransactionId: reference?.id,
      balanceAfter: wallet.balance,
      at,
    });
    return { status: Status.Rejected, failureCode: decision.code };
  }

  const referenceTransactionId = transaction.referenceExternalTransactionId
    ? reference?.id
    : undefined;
  const direction = transaction.ledgerDirectionFor(reference);

  if (direction === undefined) {
    // LOSS: registra o resultado sem mover saldo e sem lançamento.
    transaction.markProcessed({ referenceTransactionId, balanceAfter: wallet.balance, at });
    return { status: Status.Processed, ledgerEntry: undefined };
  }

  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    const failureCode = debitRejectionCode(transaction);
    transaction.reject(failureCode, { referenceTransactionId, balanceAfter: wallet.balance, at });
    return { status: Status.Rejected, failureCode };
  }

  const movement = wallet.move(direction, transaction.money, at);
  const ledgerEntry = WalletLedgerEntry.create({
    ...movement,
    id: input.ledgerEntryId,
    walletId: wallet.id,
    transactionId: transaction.id,
    createdAt: at,
  });
  transaction.markProcessed({ referenceTransactionId, balanceAfter: movement.balanceAfter, at });

  return { status: Status.Processed, ledgerEntry };
}

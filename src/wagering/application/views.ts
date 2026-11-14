import type { FailureCategory, FailureCode } from "../domain/failure-code";
import { failureCategoryOf } from "../domain/failure-code";
import type { LedgerDirection } from "../domain/ledger/ledger-direction";
import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import type { MoneyProps } from "../domain/money";
import type { WagerTransaction } from "../domain/wager-transaction/wager-transaction";
import type { WagerTransactionKind } from "../domain/wager-transaction/wager-transaction-kind";
import type { WagerTransactionStatus } from "../domain/wager-transaction/wager-transaction-status";
import type { Wallet } from "../domain/wallet/wallet";

/** Representação da wallet devolvida pelos casos de uso (formato do enunciado). */
export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export function walletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

/** Resultado de uma submissão (formato do enunciado, com o código de falha quando houver). */
export interface WagerTransactionResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  /** Saldo observado quando a transação terminou; null se pendente ou não exposto. */
  readonly balance: MoneyProps | null;
  readonly idempotentReplay: boolean;
  readonly failureCode?: FailureCode;
  readonly failureCategory?: FailureCategory;
}

/**
 * Monta o resultado a partir do que está gravado na transação. Por isso o replay devolve
 * exatamente o resultado original, inclusive o saldo da época (regra 7.7).
 */
export function wagerTransactionResult(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): WagerTransactionResult {
  const failureCode = transaction.failureCode;
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.balanceAfter?.toJSON() ?? null,
    idempotentReplay,
    ...(failureCode ? { failureCode, failureCategory: failureCategoryOf(failureCode) } : {}),
  };
}

/** Transação completa, para as consultas. Campos ausentes aparecem como null (schema estável). */
export interface WagerTransactionView {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly status: WagerTransactionStatus;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly failureCode: FailureCode | null;
  readonly failureCategory: FailureCategory | null;
  readonly balanceAfter: MoneyProps | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
}

export function wagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  const failureCode = transaction.failureCode ?? null;
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
    status: transaction.status,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode,
    failureCategory: failureCode ? failureCategoryOf(failureCode) : null,
    balanceAfter: transaction.balanceAfter?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly walletVersion: number;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly createdAt: string;
}

export function ledgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

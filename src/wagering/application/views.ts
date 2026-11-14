import type { FailureCategory, FailureCode } from "../domain/failure-code";
import { failureCategoryOf } from "../domain/failure-code";
import type { MoneyProps } from "../domain/money";
import type { WagerTransaction } from "../domain/wager-transaction/wager-transaction";
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

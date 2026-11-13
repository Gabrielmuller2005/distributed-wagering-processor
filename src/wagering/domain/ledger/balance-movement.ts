import type { Money } from "../money";
import type { LedgerDirection } from "./ledger-direction";

/**
 * Dados de uma movimentação de saldo, devolvidos por Wallet.open/debit/credit.
 * É exatamente o que um WalletLedgerEntry precisa, então saldo e ledger nascem do mesmo cálculo.
 */
export interface BalanceMovement {
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
}

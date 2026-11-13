import { DomainError } from "../../../shared/domain/domain-error";
import type { LedgerDirection } from "../ledger/ledger-direction";
import type { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { MoneyProps } from "../money";
import type { Wallet } from "../wallet/wallet";
import { type EventContext, IntegrationEvent } from "./integration-event";

export class LedgerEntryWalletMismatchError extends DomainError {
  readonly code = "LEDGER_ENTRY_WALLET_MISMATCH";

  constructor(walletId: string, entry: WalletLedgerEntry) {
    super(`Ledger entry ${entry.id} belongs to wallet ${entry.walletId}, not ${walletId}`);
  }
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  /** Versão da wallet depois da mudança: permite ao consumidor detectar lacunas e ordem. */
  readonly walletVersion: number;
}

/**
 * Emitido **somente** quando o saldo muda. Como só existe a partir de um lançamento do ledger,
 * não há como emitir este evento para LOSS ou para uma rejeição.
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  static readonly EVENT_TYPE = "WalletBalanceChanged";
  readonly eventType = WalletBalanceChanged.EVENT_TYPE;
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) throw new LedgerEntryWalletMismatchError(wallet.id, entry);

    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        ledgerEntryId: entry.id,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

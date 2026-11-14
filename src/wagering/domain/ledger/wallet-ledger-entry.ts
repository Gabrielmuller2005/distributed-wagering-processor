import { DomainError } from "../../../shared/domain/domain-error";
import type { Money } from "../money";
import type { BalanceMovement } from "./balance-movement";
import { LedgerDirection } from "./ledger-direction";

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";

  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}

export interface CreateLedgerEntryProps extends BalanceMovement {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger: imutável por estrutura (campos readonly, sem setters nem transições,
 * instância congelada) e, na persistência, por trigger que bloqueia UPDATE e DELETE.
 */
export class WalletLedgerEntry {
  private readonly createdAtMs: number;

  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    createdAt: Date,
  ) {
    // Date é mutável: guardamos o instante, e não a referência recebida.
    this.createdAtMs = createdAt.getTime();
    Object.freeze(this);
  }

  /** Cria um lançamento novo, validando a aritmética: balanceBefore ± money === balanceAfter. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(props);

    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvalidLedgerEntryError(
        `walletVersion must be an integer >= 1, got ${entry.walletVersion}`,
      );
    }
    if (!entry.money.isPositive()) {
      throw new InvalidLedgerEntryError(`amount must be positive, got ${entry.money.toString()}`);
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("balances must not be negative");
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `${entry.balanceBefore.toString()} ${entry.direction === LedgerDirection.Debit ? "-" : "+"} ${entry.money.toString()} != ${entry.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstrói um lançamento já persistido, sem revalidar. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  isBalanced(): boolean {
    // add/subtract já lançam CurrencyMismatchError se as moedas divergirem.
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static build(props: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt,
    );
  }
}

import { DomainError } from "../../../shared/domain/domain-error";
import type { BalanceMovement } from "../ledger/balance-movement";
import { LedgerDirection } from "../ledger/ledger-direction";
import { CurrencyMismatchError, Money } from "../money";

/** Tentativa de debitar mais do que o saldo. As regras de negócio checam `canDebit` antes. */
export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(balance: Money, requested: Money) {
    super(`Insufficient funds: balance ${balance.toString()}, requested ${requested.toString()}`);
  }
}

/** Valor de movimentação inválido (zero ou negativo). */
export class InvalidWalletOperationError extends DomainError {
  readonly code = "INVALID_WALLET_OPERATION";

  constructor(reason: string) {
    super(`Invalid wallet operation: ${reason}`);
  }
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenedWallet {
  readonly wallet: Wallet;
  /** Crédito de abertura; ausente quando o saldo inicial é zero. */
  readonly openingMovement: BalanceMovement | undefined;
}

const INITIAL_VERSION = 1;

/**
 * Aggregate root da carteira.
 *
 * Invariantes garantidas aqui (e repetidas no banco):
 * - saldo nunca negativo;
 * - moeda de toda movimentação igual à moeda da wallet;
 * - `version` começa em 1 e incrementa só quando o saldo muda;
 * - toda mudança de saldo devolve um BalanceMovement, que vira o lançamento no ledger.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e `version = 1`. Um saldo inicial positivo gera o
   * movimento de crédito de abertura (0 → saldo inicial), que vira a transação OPENING no ledger.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError("initial balance must not be negative");
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      INITIAL_VERSION,
      props.at,
      props.at,
    );

    const openingMovement: BalanceMovement | undefined = props.initialBalance.isZero()
      ? undefined
      : {
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(props.initialBalance.currency),
          balanceAfter: props.initialBalance,
        };

    return { wallet, openingMovement };
  }

  /** Reconstrução a partir da persistência: não revalida invariantes. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Se o débito cabe no saldo. Lança erro se a moeda for diferente da wallet. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, at: Date): BalanceMovement {
    this.assertValidAmount(money);
    if (!this.canDebit(money)) throw new InsufficientFundsError(this._balance, money);
    return this.apply(LedgerDirection.Debit, money, this._balance.subtract(money), at);
  }

  credit(money: Money, at: Date): BalanceMovement {
    this.assertValidAmount(money);
    return this.apply(LedgerDirection.Credit, money, this._balance.add(money), at);
  }

  /** Movimenta na direção indicada (usado pelo ROLLBACK, cuja direção vem da referência). */
  move(direction: LedgerDirection, money: Money, at: Date): BalanceMovement {
    return direction === LedgerDirection.Debit ? this.debit(money, at) : this.credit(money, at);
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    balanceAfter: Money,
    at: Date,
  ): BalanceMovement {
    const movement: BalanceMovement = {
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
    };
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return movement;
  }

  private assertValidAmount(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError(`amount must be positive, got ${money.toString()}`);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

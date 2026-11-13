import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./money.errors";

/** Contrato de entrada e saída do dinheiro: valor sempre como string decimal. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/** Escala fixa: todo valor tem exatamente 2 casas decimais. */
const SCALE = 2;

/**
 * Limite de dígitos inteiros, alinhado à coluna numeric(19,2) do banco (19 - 2 = 17).
 * Rejeitar no domínio evita que um valor válido aqui estoure no banco.
 */
const MAX_INTEGER_DIGITS = 17;

/**
 * Apenas dígitos ASCII, sem sinal, sem espaços, sem notação científica, até 2 casas decimais.
 * Isso rejeita por construção: NaN, Infinity, "1e3", "", "-10", "+10", ".5", "10.", "10,00".
 */
const AMOUNT_PATTERN = new RegExp(`^\\d{1,${MAX_INTEGER_DIGITS}}(\\.\\d{1,${SCALE}})?$`);

/** Código ISO-4217: três letras maiúsculas. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Construtor de Decimal isolado do global, para nenhuma configuração externa afetar o dinheiro.
 * Com precisão de 40 dígitos, soma e subtração de valores com 2 casas são sempre exatas.
 * Os limites de expoente impedem que toString use notação científica.
 */
const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

/**
 * Value object imutável para valores monetários.
 *
 * Contratos de entrada (`from`) só aceitam valores não negativos. Resultados internos de
 * aritmética podem ser negativos (ex.: saldo projetado), e quem decide se isso é permitido é
 * a regra de negócio que usa o Money, não o Money.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Cria a partir do contrato de entrada, validando valor e moeda. */
  static from(props: MoneyProps): Money {
    const amount: unknown = props?.amount;

    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        "INVALID_AMOUNT",
        `Invalid amount ${JSON.stringify(amount) ?? String(amount)}: expected a non-negative decimal string with up to ${SCALE} decimal places and ${MAX_INTEGER_DIGITS} integer digits`,
      );
    }

    return Money.of(new MoneyDecimal(amount), Money.parseCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return Money.of(new MoneyDecimal(0), Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /**
   * Igualdade de valor: mesma moeda e mesmo valor. Moedas diferentes resultam em `false`,
   * sem erro, porque "10 BRL é igual a 10 USD?" tem resposta (não). Já ordenação entre moedas
   * diferentes não tem significado, por isso `isLessThan` lança erro.
   */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Valor com exatamente 2 casas decimais, ex.: "25.00". Não inclui a moeda. */
  toString(): string {
    // Decimal#toFixed formata a partir da representação decimal exata (não é Number#toFixed).
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  /** Factory interna para resultados de operações, já validados. Normaliza -0 para 0. */
  private static of(value: Decimal, currency: string): Money {
    return new Money(value.isZero() ? new MoneyDecimal(0) : value, currency);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        "INVALID_CURRENCY",
        `Invalid currency ${JSON.stringify(currency) ?? String(currency)}: expected an ISO-4217 code (three uppercase letters)`,
      );
    }
    return currency;
  }
}

import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
  type MoneyProps,
} from "../../../../src/wagering/domain/money";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

/** Simula um payload vindo de fora (JSON), onde os tipos não são garantidos em tempo de execução. */
const untrusted = (props: Record<string, unknown>): MoneyProps => props as unknown as MoneyProps;

function invalidMoneyCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof InvalidMoneyError) return error.code;
    throw error;
  }
  throw new Error("expected InvalidMoneyError");
}

describe("Money.from: escala e serialização", () => {
  test.each([
    ["25", "25.00"],
    ["25.5", "25.50"],
    ["25.50", "25.50"],
    ["0", "0.00"],
    ["0.01", "0.01"],
    ["007.10", "7.10"],
    ["12345678901234567.89", "12345678901234567.89"],
  ])("%p é serializado como %p", (input, expected) => {
    const money = brl(input);

    expect(money.toString()).toBe(expected);
    expect(money.toJSON()).toEqual({ amount: expected, currency: "BRL" });
  });

  test("JSON.stringify usa o contrato { amount, currency } com amount em string", () => {
    expect(JSON.stringify({ balance: brl("10") })).toBe(
      '{"balance":{"amount":"10.00","currency":"BRL"}}',
    );
  });

  test("toJSON devolve um objeto novo, desacoplado da instância", () => {
    const money = brl("10.00");
    const props = money.toJSON() as { amount: string };
    props.amount = "999.00";

    expect(money.toString()).toBe("10.00");
  });

  test("Money.zero cria o zero da moeda", () => {
    const zero = Money.zero("BRL");

    expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(zero.isZero()).toBe(true);
  });
});

describe("Money.from: rejeita entradas inválidas", () => {
  test.each([
    ["", "string vazia"],
    ["   ", "só espaços"],
    [" 10.00", "espaço à esquerda"],
    ["10.00 ", "espaço à direita"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["1e3", "notação científica"],
    ["1E3", "notação científica maiúscula"],
    ["2.5e-1", "notação científica com fração"],
    ["10.001", "mais de 2 casas decimais"],
    ["0.001", "mais de 2 casas decimais em valor pequeno"],
    ["-10.00", "valor negativo"],
    ["-0.00", "zero negativo"],
    ["+10.00", "sinal explícito"],
    [".50", "sem parte inteira"],
    ["10.", "ponto sem casas decimais"],
    ["10,00", "vírgula como separador"],
    ["1_000.00", "separador de milhar"],
    ["0x10", "hexadecimal"],
    ["١٠", "dígitos não ASCII (árabe-índicos)"],
    ["123456789012345678.00", "mais de 17 dígitos inteiros (excede numeric(19,2))"],
  ])("rejeita %p (%s)", (amount) => {
    expect(invalidMoneyCode(() => brl(amount))).toBe("INVALID_AMOUNT");
  });

  // Cada caso vai num array próprio: uma linha `[]` viraria zero argumentos.
  test.each([[10], [10.5], [null], [undefined], [{}], [[]], [true]])(
    "rejeita amount que não é string em tempo de execução: %p",
    (amount) => {
      expect(invalidMoneyCode(() => Money.from(untrusted({ amount, currency: "BRL" })))).toBe(
        "INVALID_AMOUNT",
      );
    },
  );

  test.each(["", "brl", "BR", "BRLL", "R$", "B1L", " BRL", 123, null])(
    "rejeita moeda fora do formato ISO-4217: %p",
    (currency) => {
      expect(invalidMoneyCode(() => Money.from(untrusted({ amount: "10.00", currency })))).toBe(
        "INVALID_CURRENCY",
      );
      expect(invalidMoneyCode(() => Money.zero(currency as string))).toBe("INVALID_CURRENCY");
    },
  );

  test("rejeita props ausentes", () => {
    expect(invalidMoneyCode(() => Money.from(untrusted({})))).toBe("INVALID_AMOUNT");
  });

  test("o erro é de domínio, com código legível por máquina e o valor recebido", () => {
    try {
      brl("abc");
      throw new Error("expected InvalidMoneyError");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect((error as InvalidMoneyError).code).toBe("INVALID_AMOUNT");
      expect((error as Error).message).toContain('"abc"');
    }
  });
});

describe("Money: aritmética exata", () => {
  test("0.10 + 0.20 é exatamente 0.30", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
  });

  test("somar 0.01 cem vezes dá exatamente 1.00", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 100; i++) total = total.add(brl("0.01"));

    expect(total.toString()).toBe("1.00");
  });

  test("subtração exata", () => {
    expect(brl("100.00").subtract(brl("80.00")).toString()).toBe("20.00");
    expect(brl("1.00").subtract(brl("0.99")).toString()).toBe("0.01");
  });

  test("valores grandes não perdem precisão", () => {
    const max = brl("99999999999999999.99");

    expect(max.subtract(brl("0.01")).toString()).toBe("99999999999999999.98");
  });

  test("resultados internos podem ser negativos", () => {
    const result = brl("20.00").subtract(brl("80.00"));

    expect(result.toString()).toBe("-60.00");
    expect(result.isNegative()).toBe(true);
  });

  test("negate inverte o sinal e preserva a moeda", () => {
    expect(brl("25.00").negate().toJSON()).toEqual({ amount: "-25.00", currency: "BRL" });
    expect(brl("25.00").negate().negate().toString()).toBe("25.00");
  });

  test("negate de zero continua sendo zero, sem -0.00", () => {
    expect(Money.zero("BRL").negate().toString()).toBe("0.00");
    expect(Money.zero("BRL").negate().isNegative()).toBe(false);
  });
});

describe("Money: conflito de moeda", () => {
  test.each([
    ["add", (a: Money, b: Money) => a.add(b)],
    ["subtract", (a: Money, b: Money) => a.subtract(b)],
    ["isLessThan", (a: Money, b: Money) => a.isLessThan(b)],
  ] as const)("%s entre moedas diferentes lança CurrencyMismatchError", (_name, operation) => {
    expect(() => operation(brl("10.00"), usd("10.00"))).toThrow(CurrencyMismatchError);
  });

  test("o erro informa as duas moedas", () => {
    try {
      brl("10.00").add(usd("10.00"));
      throw new Error("expected CurrencyMismatchError");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).code).toBe("CURRENCY_MISMATCH");
      expect((error as Error).message).toContain("BRL");
      expect((error as Error).message).toContain("USD");
    }
  });

  test("equals entre moedas diferentes é false (igualdade de valor, não ordenação)", () => {
    expect(brl("10.00").equals(usd("10.00"))).toBe(false);
  });
});

describe("Money: comparações", () => {
  test("isZero, isPositive e isNegative", () => {
    expect(brl("0").isZero()).toBe(true);
    expect(brl("0").isPositive()).toBe(false);
    expect(brl("0").isNegative()).toBe(false);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").isZero()).toBe(false);
  });

  test("isLessThan", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
    expect(brl("80.01").isLessThan(brl("80.00"))).toBe(false);
  });

  test("equals compara valor e moeda, ignorando a forma de escrita", () => {
    expect(brl("10").equals(brl("10.00"))).toBe(true);
    expect(brl("10.5").equals(brl("10.50"))).toBe(true);
    expect(brl("10.00").equals(brl("10.01"))).toBe(false);
  });
});

describe("Money: imutabilidade", () => {
  test("operações devolvem novas instâncias e não alteram os operandos", () => {
    const a = brl("10.00");
    const b = brl("5.00");

    const sum = a.add(b);
    const difference = a.subtract(b);
    const negated = a.negate();

    expect(sum).not.toBe(a);
    expect(difference).not.toBe(a);
    expect(negated).not.toBe(a);
    expect(a.toString()).toBe("10.00");
    expect(b.toString()).toBe("5.00");
  });

  test("a instância é congelada: alterar a moeda lança TypeError", () => {
    const money = brl("10.00");

    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = "USD";
    }).toThrow(TypeError);
    expect(money.currency).toBe("BRL");
  });
});

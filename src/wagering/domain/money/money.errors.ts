import { DomainError } from "../../../shared/domain/domain-error";

export type InvalidMoneyCode = "INVALID_AMOUNT" | "INVALID_CURRENCY";

/** Valor ou moeda que não respeita o contrato de entrada do Money. */
export class InvalidMoneyError extends DomainError {
  constructor(
    readonly code: InvalidMoneyCode,
    message: string,
  ) {
    super(message);
  }
}

/** Operação entre valores de moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

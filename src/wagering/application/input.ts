import { InvalidMoneyError, Money, type MoneyProps } from "../domain/money";
import { ValidationError, type ValidationErrorCode } from "./errors";

/**
 * Validação de entrada comum aos casos de uso. Payloads chegam como JSON (HTTP e SQS), então os
 * tipos do TypeScript não protegem em tempo de execução: cada campo é conferido aqui.
 */

/** Limite dos identificadores externos, igual ao CHECK do banco. */
export const MAX_IDENTIFIER_LENGTH = 128;

export function requireString(
  value: unknown,
  field: string,
  options: { readonly maxLength?: number; readonly missingCode?: ValidationErrorCode } = {},
): string {
  const maxLength = options.maxLength ?? MAX_IDENTIFIER_LENGTH;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(
      options.missingCode ?? "MISSING_FIELD",
      field,
      `${field} is required and must be a non-empty string`,
    );
  }
  if (value.length > maxLength) {
    throw new ValidationError(
      "INVALID_FIELD",
      field,
      `${field} must have at most ${maxLength} characters`,
    );
  }
  return value;
}

/** Campo opcional: ausente ou null vira undefined; se presente, precisa ser string válida. */
export function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined || value === null ? undefined : requireString(value, field);
}

export function parseMoney(value: unknown, field: string): Money {
  if (value === null || typeof value !== "object") {
    throw new ValidationError(
      "MISSING_FIELD",
      field,
      `${field} must be an object { amount, currency }`,
    );
  }
  try {
    return Money.from(value as MoneyProps);
  } catch (error: unknown) {
    if (error instanceof InvalidMoneyError) {
      throw new ValidationError(error.code, field, error.message);
    }
    throw error;
  }
}

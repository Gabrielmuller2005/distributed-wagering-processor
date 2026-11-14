import { createHash } from "node:crypto";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/**
 * JSON canônico: chaves de objeto em ordem lexicográfica (recursivamente), arrays na ordem
 * original e sem espaços. Duas representações do mesmo dado produzem exatamente a mesma string,
 * não importa a ordem em que as chaves chegaram.
 */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const object = value as { readonly [key: string]: Json };
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as Json)}`);
  return `{${entries.join(",")}}`;
}

/** SHA-256 em hexadecimal minúsculo (64 caracteres), o formato que o banco exige. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Campos de negócio de uma transação submetida: é só o que entra no payloadHash. */
export interface WagerPayloadFields {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  /** Já normalizado (ex.: "25.00"), para "25" e "25.00" serem o mesmo payload. */
  readonly amount: string;
  readonly currency: string;
  readonly referenceExternalTransactionId: string | null;
}

/**
 * payloadHash = SHA-256 do JSON canônico dos campos de negócio.
 *
 * Ficam fora: a idempotency key (é a chave da comparação, não o conteúdo) e metadados de
 * transporte (headers, messageId, correlationId, horários). A referência ausente entra como
 * `null`, para "sem referência" e "referência vazia" nunca colidirem por omissão de campo.
 */
export function wagerPayloadHash(fields: WagerPayloadFields): string {
  return sha256Hex(
    canonicalJson({
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      playerId: fields.playerId,
      walletId: fields.walletId,
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: { amount: fields.amount, currency: fields.currency },
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    }),
  );
}

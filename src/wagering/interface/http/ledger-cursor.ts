import { ValidationError } from "../../application/errors";

/**
 * Cursor da paginação do ledger: opaco para o cliente (base64url) e estável.
 * Codifica a última `wallet_version` entregue. Como a versão é única por wallet e nunca muda,
 * a próxima página nunca pula nem repete lançamentos, mesmo com novas movimentações chegando.
 */
const CURSOR_VERSION = 1;

interface CursorPayload {
  readonly v: number;
  readonly after: number;
}

export function encodeLedgerCursor(afterVersion: number): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, after: afterVersion };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeLedgerCursor(cursor: unknown): number | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  const invalid = () => new ValidationError("INVALID_FIELD", "cursor", "cursor is invalid");
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();

  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (payload.v !== CURSOR_VERSION || !Number.isInteger(payload.after) || payload.after < 0) {
      throw invalid();
    }
    return payload.after;
  } catch {
    throw invalid();
  }
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export function parseLedgerLimit(limit: unknown): number {
  if (limit === undefined || limit === "") return DEFAULT_LEDGER_LIMIT;
  if (typeof limit !== "string" || !/^\d{1,4}$/.test(limit)) {
    throw new ValidationError(
      "INVALID_FIELD",
      "limit",
      `limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`,
    );
  }
  const value = Number.parseInt(limit, 10);
  if (value < 1 || value > MAX_LEDGER_LIMIT) {
    throw new ValidationError(
      "INVALID_FIELD",
      "limit",
      `limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`,
    );
  }
  return value;
}

/** Corpo JSON como registro; qualquer outra forma (array, string, vazio) vira objeto vazio e cai na validação. */
export function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** O mínimo da resposta HTTP para os controllers definirem o status (independe do adapter). */
export interface StatusResponse {
  status(code: number): unknown;
}

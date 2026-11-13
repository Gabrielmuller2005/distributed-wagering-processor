export interface BackoffPolicy {
  /** Atraso da primeira nova tentativa, em milissegundos. */
  readonly baseDelayMs: number;
  /** Teto do atraso, em milissegundos. */
  readonly maxDelayMs: number;
}

/**
 * Backoff exponencial com "equal jitter".
 *
 * O atraso exponencial é `min(teto, base * 2^(tentativa - 1))`. O atraso final fica entre
 * metade dele e ele inteiro: `exp/2 + random * exp/2`. A metade fixa garante que o atraso cresce
 * de fato; a metade aleatória espalha as novas tentativas de várias instâncias, para não chegarem
 * todas ao mesmo tempo depois de uma falha comum (ex.: SQS fora do ar).
 *
 * @param attempt número da tentativa que falhou, começando em 1.
 * @param random fonte de aleatoriedade em [0, 1), injetável para testes determinísticos.
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be an integer >= 1, got ${attempt}`);
  }

  // Limitar o expoente evita 2^n gigantesco (ou Infinity) em tentativas muito altas.
  const exponent = Math.min(attempt - 1, 30);
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const half = exponential / 2;
  return Math.floor(half + random() * half);
}

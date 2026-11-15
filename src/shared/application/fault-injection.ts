export const FAULT_INJECTOR = Symbol("FAULT_INJECTOR");

/**
 * Pontos onde um teste de resiliência pode matar o processo, sempre entre duas operações que
 * não são atômicas entre si (banco e fila):
 * - `after-commit-before-ack`: a transação SQL confirmou e a mensagem SQS ainda não foi apagada;
 * - `after-reserve-before-publish`: o lote da outbox foi reservado e nada foi publicado;
 * - `after-publish-before-record`: o broker confirmou a publicação e o banco ainda não sabe.
 */
export const FAULT_POINTS = [
  "after-commit-before-ack",
  "after-reserve-before-publish",
  "after-publish-before-record",
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface FaultInjector {
  /** Chamado ao passar pelo ponto. Sem fault injection configurada, nunca faz nada. */
  reached(point: FaultPoint): void;
}

export const NO_FAULTS: FaultInjector = Object.freeze({ reached: () => {} });

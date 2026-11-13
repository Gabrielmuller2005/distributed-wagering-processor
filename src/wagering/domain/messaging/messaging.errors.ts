import { DomainError } from "../../../shared/domain/domain-error";

/** Operação incompatível com o estado da mensagem (ex.: publicar duas vezes). */
export class InvalidMessageStateError extends DomainError {
  readonly code = "INVALID_MESSAGE_STATE";

  constructor(message: string) {
    super(message);
  }
}

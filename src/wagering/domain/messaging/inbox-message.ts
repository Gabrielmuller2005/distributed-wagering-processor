import { InvalidMessageStateError } from "./messaging.errors";

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date | undefined;
}

/**
 * Registro de uma mensagem recebida da fila, por consumidor.
 *
 * A chave é (consumerName, messageId). O registro é gravado na **mesma transação SQL** do
 * processamento: se a transação confirma, a mensagem consta como processada; se desfaz, não
 * consta. Assim, uma redelivery do SQS é reconhecida e não duplica efeitos, com várias instâncias.
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const field of ["messageId", "consumerName", "payloadHash"] as const) {
      if (props[field].trim() === "") {
        throw new InvalidMessageStateError(`inbox ${field} must not be empty`);
      }
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /**
   * Mesmo messageId com conteúdo diferente não é redelivery: indica um produtor reutilizando ids.
   * O consumidor trata isso como erro permanente, em vez de ignorar a mensagem em silêncio.
   */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(
        `inbox message ${this.consumerName}/${this.messageId} is already processed`,
      );
    }
    this._processedAt = at;
  }
}

/**
 * Base dos erros de domínio: violações de regra de negócio ou de invariante.
 *
 * Cada erro tem um `code` estável e legível por máquina. As camadas externas (HTTP, SQS)
 * traduzem o código em resposta sem depender do texto da mensagem, que existe só para humanos.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

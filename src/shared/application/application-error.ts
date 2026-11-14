/**
 * Base dos erros da camada de aplicação: situações que não são regra de domínio, mas que o
 * chamador precisa distinguir (conflito, recurso inexistente, concorrência).
 * Como os erros de domínio, cada um tem um `code` estável, traduzido pelas camadas externas.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

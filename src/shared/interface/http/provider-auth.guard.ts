import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

/**
 * Ponto de extensão da autenticação (seção 2 do enunciado: opcional e sem pontos).
 *
 * Desenho que seria adotado: cada provedor é um client OIDC num Identity Provider externo
 * (ex.: Keycloak) e chama a API com um access token obtido por client credentials. A
 * implementação desta port validaria o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e extrairia
 * o providerId de uma claim. Um guard por rota garantiria que o `providerId` do corpo ou da URL
 * é o mesmo do token, para um provedor nunca operar em nome de outro.
 */
export interface ProviderIdentityPort {
  /** Se a requisição pode seguir. Recebe os headers HTTP da requisição. */
  isAllowed(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<boolean>;
}

/**
 * Autenticação desligada: toda requisição é aceita. Decisão documentada no ARCHITECTURE.md;
 * trocar esta classe por uma implementação OIDC liga a autenticação sem mudar os controllers.
 */
export class AuthenticationDisabled implements ProviderIdentityPort {
  async isAllowed(): Promise<boolean> {
    return true;
  }
}

/** Guard aplicado aos endpoints de negócio. Os de health ficam abertos, como pede o enunciado. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    return this.identity.isAllowed(request.headers);
  }
}

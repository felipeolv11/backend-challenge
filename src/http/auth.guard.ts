import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

// DECISÃO: autenticação NÃO implementada neste desafio; fica este ponto de extensão (no-op).
// POR QUÊ: a seção 2 do enunciado diz que autenticação não vale pontos e aceita não implementar,
//          desde que documentado. O tempo foi para correção financeira, concorrência e idempotência.
// ALTERNATIVA: integrar Keycloak agora — não usei porque consumiria boa parte do prazo de 3 dias
//              em algo que não pontua.
//
// Desenho que eu adotaria (detalhado no ARCHITECTURE.md, seção 10):
//  1. Keycloak no docker-compose; cada provedor é um "client" com client credentials (OAuth2).
//  2. O provedor obtém um JWT e manda em Authorization: Bearer <token>.
//  3. Este guard valida assinatura (JWKS do Keycloak), expiração, issuer e audience.
//  4. O providerId vem do token (ex.: claim "azp") e é guardado na requisição.
//  5. O controller confere que o providerId do PAYLOAD é o mesmo do TOKEN (senão 403): um provedor
//     não pode lançar transações em nome de outro.
// Os endpoints de health não usam este guard (ficam abertos), e a fila é canal interno confiável.
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

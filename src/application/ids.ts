/**
 * Gera ids UUID v7 (ordenados pelo tempo, como nos exemplos do enunciado).
 * Ids ordenados pelo tempo deixam os índices do banco mais eficientes e servem de ordem
 * natural para o extrato (ledger).
 */
export function newId(): string {
  return Bun.randomUUIDv7();
}

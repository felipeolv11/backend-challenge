// Tipos mínimos de request/response do Express usados pela aplicação.
// Evita depender do pacote @types/express só para isso.

export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

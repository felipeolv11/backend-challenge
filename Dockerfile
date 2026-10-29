# Imagem da aplicação. O Bun roda TypeScript direto, então não há etapa de build.
FROM oven/bun:1.4.4

WORKDIR /app

# Dependências primeiro (camada reaproveitada enquanto package.json/bun.lock não mudam).
# --production: sem typescript e @types/bun, que só servem para a checagem de tipos.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# A imagem não tem curl: o healthcheck usa o próprio Bun para chamar o /health/ready.
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD ["bun", "-e", "fetch('http://localhost:3000/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "run", "src/main.ts"]

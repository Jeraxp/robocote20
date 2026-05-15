# Robocote 2.0 — imagem do mostruário rodando no swarm Hetzner.
# Multi-stage: builda o frontend Vite no estágio "builder" e copia só o necessário
# pro runtime. Backend roda com tsx (mesma estratégia do dev — sem compilar pra JS).

FROM node:20-alpine AS builder

WORKDIR /app

# Instala deps com lock pra build reproduzível.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copia o que precisa pra buildar.
COPY tsconfig.json tsconfig.frontend.json vite.config.ts ./
COPY src ./src
COPY frontend ./frontend
COPY persona ./persona
# public/index.html é estático (bancada técnica) — preserva no builder
# pra que ele e o quote-room/ buildado coexistam no /app/public final.
COPY public/index.html ./public/index.html

# Builda o frontend (vai pra public/quote-room/).
RUN npm run build:web

# ---------------------------------------------------------------------------

FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3030

WORKDIR /app

# Só prod deps + tsx (que está em devDependencies mas precisamos em runtime).
COPY package.json package-lock.json ./
RUN npm ci --include=dev --omit=optional && npm cache clean --force

# Copia código + artefatos buildados.
COPY tsconfig.json tsconfig.frontend.json vite.config.ts ./
COPY src ./src
COPY frontend ./frontend
COPY persona ./persona
COPY --from=builder /app/public ./public

# Logs ficam dentro do container; volume opcional no compose.
RUN mkdir -p logs

EXPOSE 3030

# Healthcheck simples na rota /health do Hono.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3030/health || exit 1

CMD ["npm", "run", "start"]

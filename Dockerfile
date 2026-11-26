# syntax=docker/dockerfile:1
# Lab 8: багатостадійний образ для workspace із трьох пакетів (shared, client, server).
#   docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t conter-pzrk .
#   docker run -p 3000:3000 -e ALLOWED_ORIGINS=http://localhost:3000 conter-pzrk

# ---------- стадія 1: збірка (тут є все: devDependencies, TypeScript, Vite) ----------
FROM node:24-alpine AS build
WORKDIR /app
# спершу ЛИШЕ package*.json: поки залежності не змінились, шар з npm ci береться з кешу,
# і зміна одного рядка коду не перевстановлює 200+ МБ пакетів
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
COPY shared shared
COPY client client
COPY server server
ARG GIT_SHA=dev
# Render збирає образ сам і передає змінні середовища як build-аргументи — серед них RENDER_GIT_COMMIT
ARG RENDER_GIT_COMMIT=
# tsc --noEmit (перевірка типів) + vite build → client/dist; SHA потрапляє в HUD
RUN GIT_SHA=${RENDER_GIT_COMMIT:-$GIT_SHA} npm run build -w client

# ---------- стадія 2: runtime (лише те, що потрібно для роботи) ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
# тільки продакшен-залежності сервера (ws, zod, pino, prom-client) — без Vite, TypeScript, Vitest, Playwright
RUN npm ci --omit=dev -w server --include-workspace-root=false --no-audit --no-fund \
  && npm cache clean --force
# сервер — це .ts, який Node 24 запускає напряму (стирання типів), тож копіюємо вихідники, а не dist
COPY shared/src shared/src
COPY server/src server/src
COPY --from=build /app/client/dist client/dist

ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA \
    HOST=0.0.0.0 \
    PORT=3000 \
    ARENAS_FILE=../client/dist/assets/arenas.json \
    LOG_DIR=/tmp/conter-logs
# не root: якщо в сервері знайдеться діра, нападник не стане root у контейнері
USER node
WORKDIR /app/server
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
# exec-форма: node — це PID 1 і сам отримує SIGTERM від `docker stop`
# (з `CMD npm start` сигнал отримав би npm, а гра — ні: через 10 с SIGKILL, гравці без пояснень)
CMD ["node", "src/index.ts"]

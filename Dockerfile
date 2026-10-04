# Skein: the read-only API plus the built web app in one Node container.
# The server runs from source with tsx (workspace packages export their src/*.ts and read data
# files relative to themselves), so the image keeps the workspace layout.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm web:build

FROM node:22-alpine
LABEL app=skein
ENV HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY --from=build /app /app
# Logos, Chainlink rounds, pool lists and rate history are cached here (a volume in compose.yaml).
RUN mkdir -p .cache && chown -R node:node .cache
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8787/api/health || exit 1
CMD ["node_modules/.bin/tsx", "apps/server/src/main.ts"]

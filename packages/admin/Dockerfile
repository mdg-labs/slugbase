# syntax=docker/dockerfile:1
# Admin portal container (Fly.io — admin PRD §5.1, §6)

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS build-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json tsconfig.json ./
COPY scripts/check-node-version.mjs scripts/check-node-version.mjs
COPY packages/admin/package.json packages/admin/
COPY packages/db-admin/package.json packages/db-admin/
COPY packages/shared-types/package.json packages/shared-types/
COPY patches/ patches/
RUN pnpm install --frozen-lockfile

FROM build-deps AS build
COPY packages/shared-types packages/shared-types
COPY packages/db-admin packages/db-admin
COPY packages/admin packages/admin
RUN pnpm exec turbo run build --filter=@slugbase/admin...

FROM build AS deploy
RUN pnpm deploy --filter=@slugbase/admin --prod /prod/admin

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy /prod/admin ./

RUN groupadd --system --gid 10001 slugbase \
  && useradd --system --uid 10001 --gid slugbase --home-dir /app --no-create-home slugbase \
  && chown -R slugbase:slugbase /app

USER slugbase
EXPOSE 3000
CMD ["node", "dist/server.js"]

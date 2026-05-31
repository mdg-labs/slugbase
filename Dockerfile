# syntax=docker/dockerfile:1
# Combined self-host image: API + bundled web on one port (spec §14.2, §22.8)

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
COPY packages/backend/package.json packages/backend/
COPY packages/web/package.json packages/web/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/ui/package.json packages/ui/
COPY packages/marketing/package.json packages/marketing/
RUN echo "shamefully-hoist=true" > .npmrc \
  && pnpm install --frozen-lockfile

FROM build-deps AS build
COPY packages/shared-types packages/shared-types
COPY packages/ui packages/ui
COPY packages/backend packages/backend
COPY packages/web packages/web
RUN pnpm exec turbo run build --filter=@slugbase/backend... --filter=@slugbase/web...

FROM base AS runtime
ENV NODE_ENV=production
ENV SERVE_WEB_CLIENT=true
ENV WEB_CLIENT_SERVER_BUILD=/app/packages/web/build/server/index.js
WORKDIR /app
COPY --from=build-deps /app/node_modules ./node_modules
COPY --from=build-deps /app/package.json ./package.json
COPY --from=build-deps /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/package.json
COPY --from=build /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/backend/migrations ./packages/backend/migrations
COPY --from=build /app/packages/web/build ./packages/web/build
WORKDIR /app/packages/backend
RUN ln -sf /app/node_modules ./node_modules
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "dist/main.js"]

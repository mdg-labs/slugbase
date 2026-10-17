# The Community Edition image: one image, three commands (server, worker, migrate;
# doc 01 section 3). Build it from the repository root:
#
#   docker build -f apps/slugbase/Dockerfile \
#     --build-arg BUILD_COMMIT=<the commit being built> \
#     --build-arg VERSION=<the release version> \
#     -t slugbase .
#
# Build arguments:
#   BUILD_COMMIT  The source revision. The build stage writes it into build-info.json
#                 (reported by GET /version) and the image labels it as
#                 org.opencontainers.image.revision. The build context holds no git
#                 history, so the release build passes it; a build without it is
#                 labelled "unknown". It is an ARG of the build and label steps only,
#                 never an ENV of the running container.
#   VERSION       The release version, for org.opencontainers.image.version only
#                 (the version GET /version reports is the one in package.json).
#
# The image runs as a non-root user on a read-only root filesystem with a tmpfs
# /tmp, and writes nowhere else:
#
#   docker run --read-only --tmpfs /tmp slugbase server
#
# Stages: toolchain (pinned Node 24 slim and pnpm) -> build (frozen-lockfile
# install, build, then the runtime dependencies only) -> runtime (the same pinned
# base, built output and production dependencies, no sources, tests or git history).

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS toolchain
RUN npm install --global --ignore-scripts pnpm@10.34.6
WORKDIR /app

# Fetching from the lockfile and the dependency patches alone keeps this layer until the dependencies change.
FROM toolchain AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
ARG BUILD_COMMIT=unknown
ENV TURBO_TELEMETRY_DISABLED=1
RUN BUILD_COMMIT="${BUILD_COMMIT}" pnpm turbo run build --filter=slugbase
# What the server imports at run time, installed again from the lockfile as
# production dependencies only (CI=true lets pnpm replace node_modules without a
# terminal). The web app is already compiled into dist/web, so the packages it was
# built from are not installed.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules tooling/node_modules \
 && CI=true pnpm install --frozen-lockfile --offline --prod --ignore-scripts \
      --filter slugbase --filter @slugbase/server... --filter @slugbase/adapters... --filter @slugbase/email...

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ARG VERSION=unreleased
ARG BUILD_COMMIT=unknown
LABEL org.opencontainers.image.title="SlugBase" \
      org.opencontainers.image.description="A keyboard-driven bookmark manager where every link can get a short, private slug" \
      org.opencontainers.image.source="https://github.com/mdg-labs/slugbase" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${BUILD_COMMIT}"
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/slugbase/package.json ./apps/slugbase/package.json
COPY --from=build /app/apps/slugbase/node_modules ./apps/slugbase/node_modules
COPY --from=build /app/apps/slugbase/dist ./apps/slugbase/dist
COPY --from=build /app/apps/slugbase/docker-entrypoint.sh ./apps/slugbase/docker-entrypoint.sh

COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
# createServer checks its routes against this document, which it reads from the
# contracts package next to the server's own module.
COPY --from=build /app/packages/contracts/generated/openapi.json ./packages/contracts/generated/openapi.json

COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist

COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations

COPY --from=build /app/packages/adapters/package.json ./packages/adapters/package.json
COPY --from=build /app/packages/adapters/node_modules ./packages/adapters/node_modules
COPY --from=build /app/packages/adapters/dist ./packages/adapters/dist

COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/server/dist ./packages/server/dist

COPY --from=build /app/packages/email/package.json ./packages/email/package.json
COPY --from=build /app/packages/email/dist ./packages/email/dist

# The links the workspace packages that are not shipped (the web app's sources
# and the test support) left behind would point nowhere.
RUN find /app -xtype l -delete

# A numeric user the files do not belong to: everything above is root-owned and
# read-only to the process.
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/app/apps/slugbase/docker-entrypoint.sh"]
CMD ["server"]

import "./instrument.js";
import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";

import { AppModule } from "./app.module.js";
import { ConfigService } from "./config/config.service.js";
import { resolveCorsOrigins } from "./config/resolve-cors-origins.js";
import { applySecurityHeaders } from "./security/apply-security-headers.js";
import { runMigrations } from "./db/migrate/run-migrations.js";
import { loadAppConfig } from "./config/load-config.js";
import { resolveMigrationDatabaseUrl } from "./config/env.schema.js";
import type { AppConfig } from "./config/env.schema.js";
import {
  parseSentryLogLevel,
  resolveNestLogLevels,
} from "./logging/sentry-log-config.js";
import { SentryLoggerService } from "./logging/sentry-logger.service.js";

/**
 * Run DB migrations only in the self-hosted deployment mode (SERVE_WEB_CLIENT=true).
 * Hosted deployments run migrations in CI before deploying to Fly.io (see CI/CD workflow).
 */
async function runMigrationsIfNeeded(config: AppConfig): Promise<void> {
  if (!config.SERVE_WEB_CLIENT) {
    return;
  }
  await runMigrations(resolveMigrationDatabaseUrl(config));
}

export async function bootstrap(): Promise<void> {
  const startupConfig = loadAppConfig(process.env);
  await runMigrationsIfNeeded(startupConfig);

  const nestLogLevels = resolveNestLogLevels({
    sentryLogLevel: parseSentryLogLevel(startupConfig.SENTRY_LOG_LEVEL),
    nodeEnv: startupConfig.nodeEnv,
  });

  const sentryLogger = startupConfig.SENTRY_DSN
    ? new SentryLoggerService()
    : undefined;
  if (sentryLogger) {
    sentryLogger.setLogLevels(nestLogLevels);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: sentryLogger ?? nestLogLevels,
    rawBody: true,
  });

  applySecurityHeaders(app, {
    enableHsts: startupConfig.nodeEnv === "production",
  });

  if (startupConfig.SERVE_WEB_CLIENT) {
    const serverBuildPath = startupConfig.WEB_CLIENT_SERVER_BUILD;
    if (!serverBuildPath) {
      throw new Error(
        "WEB_CLIENT_SERVER_BUILD is required when SERVE_WEB_CLIENT is enabled",
      );
    }
    const { registerWebClientMiddleware } = await import(
      "./web-client/mount-web-client.js"
    );
    await registerWebClientMiddleware(app, serverBuildPath);
  }

  app.use(cookieParser());
  await app.init();

  const config = app.get(ConfigService);

  // CORS for cross-origin client requests (hosted: web + marketing CF Workers → Fly.io API)
  app.enableCors({
    origin: resolveCorsOrigins(config.getAll()),
    credentials: true,
  });

  await app.listen(config.get("PORT"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  bootstrap().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

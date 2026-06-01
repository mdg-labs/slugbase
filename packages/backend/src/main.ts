import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";

import { AppModule } from "./app.module.js";
import { ConfigService } from "./config/config.service.js";
import { runMigrations } from "./db/migrate/run-migrations.js";
import { validateEnvConfig, resolveMigrationDatabaseUrl } from "./config/env.schema.js";
export async function bootstrap(): Promise<void> {
  const startupConfig = validateEnvConfig(process.env);
  await runMigrations(resolveMigrationDatabaseUrl(startupConfig));

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["error", "warn"],
    rawBody: true,
  });
  app.use(cookieParser());
  await app.init();

  const config = app.get(ConfigService);
  if (config.get("SERVE_WEB_CLIENT")) {
    const serverBuildPath = config.get("WEB_CLIENT_SERVER_BUILD");
    if (!serverBuildPath) {
      throw new Error(
        "WEB_CLIENT_SERVER_BUILD is required when SERVE_WEB_CLIENT is enabled",
      );
    }
    const { mountWebClient } = await import("./web-client/mount-web-client.js");
    await mountWebClient(app, serverBuildPath);
  }

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

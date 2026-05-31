import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { fileURLToPath } from "node:url";

import { AppModule } from "./app.module.js";
import { ConfigService } from "./config/config.service.js";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  const config = app.get(ConfigService);
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

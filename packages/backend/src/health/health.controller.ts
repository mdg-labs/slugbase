import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  HealthResponseSchema,
  VersionResponseSchema,
} from "@slugbase/shared-types";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(currentDir, "..", "..", "package.json");
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

@Controller()
@SkipThrottle({ ip: true, "user-hour": true })
export class HealthController {
  private readonly version = readPackageVersion();

  @Get("health")
  getHealth() {
    const body = { status: "ok" as const };
    return HealthResponseSchema.parse(body);
  }

  @Get("version")
  getVersion() {
    const body = { version: this.version };
    return VersionResponseSchema.parse(body);
  }
}

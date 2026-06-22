import type { AppConfig } from "./env.schema.js";

/** Allowed browser origins for API CORS (web app + marketing site). */
export function resolveCorsOrigins(
  config: Pick<AppConfig, "FRONTEND_ORIGIN" | "MARKETING_ORIGIN">,
): string[] {
  const origins = [config.FRONTEND_ORIGIN];
  const marketing = config.MARKETING_ORIGIN?.trim();
  if (marketing && marketing !== config.FRONTEND_ORIGIN) {
    origins.push(marketing);
  }
  return origins;
}

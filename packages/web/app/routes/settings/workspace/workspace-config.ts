import { loadBillingPlanDisplayConfig } from "../billing/billing-config.js";
import type { WorkspaceInterfaceConfig } from "./workspace.types.js";

function readEnv(key: string): string | undefined {
  if (!(key in import.meta.env)) {
    const nodeValue = process.env[key];
    return typeof nodeValue === "string" && nodeValue.length > 0 ? nodeValue : undefined;
  }
  const value: unknown = import.meta.env[key as keyof ImportMetaEnv];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  const nodeValue = process.env[key];
  return typeof nodeValue === "string" && nodeValue.length > 0 ? nodeValue : undefined;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

/**
 * Interface-selection flags for workspace settings panels (spec §10.1, §15).
 * Mirrors which configuration source is active — never deployment-mode branching.
 */
export async function loadWorkspaceInterfaceConfig(
  overrides: Partial<WorkspaceInterfaceConfig> = {},
): Promise<WorkspaceInterfaceConfig> {
  const billing = await loadBillingPlanDisplayConfig();
  return {
    mailAdminUi: readBoolean(readEnv("VITE_MAIL_ADMIN_UI"), !billing.billingEnabled),
    oidcAdminUi: readBoolean(readEnv("VITE_OIDC_ADMIN_UI"), !billing.billingEnabled),
    aiByoCredential: readBoolean(readEnv("VITE_AI_BYO_CREDENTIAL"), !billing.billingEnabled),
    billingEnabled: billing.billingEnabled,
    ...overrides,
  };
}

export function readAppBaseUrl(): string {
  return (
    readEnv("VITE_APP_BASE_URL") ??
    readEnv("API_BASE_URL") ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

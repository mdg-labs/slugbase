import {
  getEditionPresets,
  parseSlugbaseEdition,
  SLUGBASE_EDITION,
  type EditionPresetKey,
} from "@slugbase/shared-types";

import { loadBillingPlanDisplayConfig } from "../billing/billing-config.js";
import type { WorkspaceInterfaceConfig } from "./workspace.types.js";

type ViteEditionEnvKey = Extract<
  EditionPresetKey,
  | "VITE_BILLING_ENABLED"
  | "VITE_MAIL_ADMIN_UI"
  | "VITE_OIDC_ADMIN_UI"
  | "VITE_AI_BYO_CREDENTIAL"
>;

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

function resolveEditionRaw(): string {
  const raw = readEnv("SLUGBASE_EDITION");
  if (raw !== undefined) {
    return raw;
  }
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv.trim().toLowerCase() === "production") {
    return SLUGBASE_EDITION.CE;
  }
  return SLUGBASE_EDITION.CE;
}

/** Edition-aware default when a VITE_* flag is unset at runtime (tests / SSR). */
export function readEditionAwareViteBoolean(key: ViteEditionEnvKey): boolean {
  const raw = readEnv(key);
  if (raw !== undefined) {
    return readBoolean(raw, false);
  }
  const edition = parseSlugbaseEdition(resolveEditionRaw());
  const preset = getEditionPresets(edition)[key];
  return readBoolean(preset, false);
}

/**
 * Interface-selection flags for workspace settings panels (spec §10.1, §15).
 * Mirrors which configuration source is active - never deployment-mode branching.
 */
export async function loadWorkspaceInterfaceConfig(
  overrides: Partial<WorkspaceInterfaceConfig> = {},
): Promise<WorkspaceInterfaceConfig> {
  const billing = await loadBillingPlanDisplayConfig();
  return {
    mailAdminUi: readEditionAwareViteBoolean("VITE_MAIL_ADMIN_UI"),
    oidcAdminUi: readEditionAwareViteBoolean("VITE_OIDC_ADMIN_UI"),
    aiByoCredential: readEditionAwareViteBoolean("VITE_AI_BYO_CREDENTIAL"),
    billingEnabled: billing.billingEnabled,
    ...overrides,
  };
}

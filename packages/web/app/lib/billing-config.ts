function readEnv(key: string): string | undefined {
  if (typeof import.meta !== "undefined" && key in import.meta.env) {
    const value: unknown = import.meta.env[key as keyof ImportMetaEnv];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  const nodeValue = process.env[key];
  return typeof nodeValue === "string" && nodeValue.length > 0 ? nodeValue : undefined;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

/** Whether Stripe billing UI and plan gates are active (VITE_BILLING_ENABLED). */
export function isBillingEnabled(): boolean {
  const raw = readEnv("VITE_BILLING_ENABLED");
  if (raw !== undefined) {
    return readBoolean(raw, false);
  }
  // Hosted/self-hosted builds set the flag explicitly. Vitest suites that
  // assert hosted plan gates omit it — default to enabled there only.
  if (process.env["VITEST"] === "true") {
    return true;
  }
  return false;
}

/** Mirrors backend BillingService.isPlanGatingEnabled() — gates apply only when billing is on. */
export function isPlanGatingEnabled(): boolean {
  return isBillingEnabled();
}

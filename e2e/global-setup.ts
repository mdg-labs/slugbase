import { clearLock } from "./support/account-preferences.ts";
import { appOrigin } from "./support/environment.ts";
import { startTlsProxy } from "./support/tls-proxy.ts";

// Runs once before the journeys. It serves the https origin the server is configured with from a TLS
// proxy in front of the stack (a browser can sign in only there), and clears the lock of the account's
// preferences that an earlier run may have left. The instance is claimed by the first journey, the
// first-run setup of tests/first-run.setup.ts, which the other journeys wait for (playwright.config.ts).

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set; run the journeys through \`bash e2e/with-stack.sh pnpm test:e2e\``);
  }
  return value;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const origin = appOrigin();
  const upstream = required("E2E_BASE_URL");
  const stopProxy =
    origin === upstream
      ? undefined
      : await startTlsProxy({
          port: Number(new URL(origin).port),
          upstream: new URL(upstream),
          keyFile: required("E2E_TLS_KEY_FILE"),
          certFile: required("E2E_TLS_CERT_FILE"),
        });
  try {
    clearLock();
  } catch (error) {
    await stopProxy?.();
    throw error;
  }
  return async () => {
    await stopProxy?.();
  };
}

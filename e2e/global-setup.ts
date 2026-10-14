import { chromium, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { message } from "./support/catalog.ts";
import { appOrigin, STORAGE_STATE } from "./support/environment.ts";
import { productName } from "./support/product.ts";
import { startTlsProxy } from "./support/tls-proxy.ts";

// Runs once before the journeys. It makes the stack a claimed instance the way an
// operator does (first-run setup, with the one-time token the server printed to its log:
// E2E_SETUP_TOKEN), signs in through the sign-in page in a browser, and keeps the session
// as the state every journey starts from (playwright.config.ts). The journeys of a
// visitor without a session start from an empty state instead.
//
// The account is made up for this run and its password is random; neither the password
// nor the token is printed, and a message that fails here names the step, never a value.

const OWNER_EMAIL = "owner@example.test";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set; run the journeys through \`bash e2e/with-stack.sh pnpm test:e2e\``);
  }
  return value;
}

/** A JSON POST to the server itself, from the origin it expects mutations from (the browsers' origin, which the TLS proxy serves). */
async function post(upstream: string, origin: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, upstream), {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

async function claimInstance(upstream: string, origin: string, password: string): Promise<void> {
  const status = await fetch(new URL("/api/v1/setup/status", upstream));
  if (!status.ok) {
    throw new Error(`GET /api/v1/setup/status answered ${String(status.status)}`);
  }
  const { setupRequired } = (await status.json()) as { setupRequired?: unknown };
  if (setupRequired !== true) {
    throw new Error("first-run setup is not pending: the journeys need a fresh stack without an account");
  }
  const token = process.env.E2E_SETUP_TOKEN;
  const response = await post(upstream, origin, "/api/v1/setup", {
    ...(token === undefined || token === "" ? {} : { setupToken: token }),
    displayName: "Owner",
    email: OWNER_EMAIL,
    password,
    workspaceName: "Journeys",
  });
  if (response.status !== 201) {
    throw new Error(`POST /api/v1/setup answered ${String(response.status)}`);
  }
}

async function signIn(origin: string, password: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, locale: "en-US" });
    const page = await context.newPage();
    await page.goto("/login");
    const card = page.getByRole("region", { name: message("en", "login.title") });
    await card.getByLabel(message("en", "login.email.label"), { exact: true }).fill(OWNER_EMAIL);
    await card.getByLabel(message("en", "login.password.label"), { exact: true }).fill(password);
    await card.getByRole("button", { name: message("en", "login.submit"), exact: true }).click();
    const name = await productName(page);
    await expect(
      page.getByRole("heading", { level: 1, name: message("en", "home.empty.title", { name }) }),
      "the home page after signing in",
    ).toBeVisible();
    mkdirSync(dirname(STORAGE_STATE), { recursive: true });
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
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
    const password = randomBytes(24).toString("base64url");
    await claimInstance(upstream, origin, password);
    await signIn(origin, password);
  } catch (error) {
    await stopProxy?.();
    throw error;
  }
  return async () => {
    await stopProxy?.();
  };
}

import { expect } from "@playwright/test";
import { REQUESTS_PATH, type ReceivedRequest } from "./ai-stub/stub.ts";

// What the server sent to the stand-in for an AI provider (e2e/compose.ai.yml), read back from the stub's own HTTP API
// (E2E_AI_STUB_URL, set by e2e/with-stack.sh). The provider is the one place the server sends the address of a page and the names of
// a member's tags to, so the journey reads the request itself and not only what the page showed.

export type { ReceivedRequest };

export function aiStubUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.E2E_AI_STUB_URL;
  if (url === undefined || url === "") {
    throw new Error("E2E_AI_STUB_URL is not set; run the journeys through `bash e2e/with-stack.sh pnpm test:e2e`");
  }
  return url;
}

/** Every request the stub received since it was last cleared, oldest first. */
export async function receivedByStub(): Promise<ReceivedRequest[]> {
  const response = await fetch(new URL(REQUESTS_PATH, aiStubUrl()));
  expect(response.status, "the AI stub lists what it received").toBe(200);
  return (await response.json()) as ReceivedRequest[];
}

/** Forgets what the stub received, so a journey counts its own requests only. */
export async function clearStub(): Promise<void> {
  const response = await fetch(new URL(REQUESTS_PATH, aiStubUrl()), { method: "DELETE" });
  expect(response.status, "the AI stub clears what it received").toBe(204);
}

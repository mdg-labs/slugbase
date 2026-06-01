import type { ContactTopic } from "./contact-config.js";

export interface ContactSubmitPayload {
  name: string;
  email: string;
  topic: ContactTopic;
  message: string;
  challengeToken: string;
}

export type ContactSubmitResult =
  | { ok: true }
  | { ok: false; status: number };

/** POST JSON body to the public contact API (P6-02). */
export async function submitContactForm(
  endpoint: string,
  payload: ContactSubmitPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<ContactSubmitResult> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  return { ok: true };
}

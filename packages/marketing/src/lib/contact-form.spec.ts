import { describe, expect, it, vi } from "vitest";

import { submitContactForm } from "./contact-form.js";

describe("submitContactForm", () => {
  const payload = {
    name: "Alex Kerr",
    email: "alex@example.com",
    topic: "support" as const,
    message: "Need help with my workspace.",
    challengeToken: "turnstile-token",
  };

  it("posts JSON to the contact endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });

    const result = await submitContactForm(
      "https://api.example.test/contact",
      payload,
      fetchMock,
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  });

  it("returns failure when the API responds with an error status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    const result = await submitContactForm(
      "https://api.example.test/contact",
      payload,
      fetchMock,
    );

    expect(result).toEqual({ ok: false, status: 429 });
  });
});

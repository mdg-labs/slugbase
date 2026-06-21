import { describe, expect, it } from "vitest";

import { renderOperatorInviteEmail } from "../mail/operator-invite.template.js";

describe("operator invite email template", () => {
  it("renders invite URL and role", () => {
    const rendered = renderOperatorInviteEmail({
      inviteUrl: "https://admin.slugbase.test/accept-invite?token=abc",
      invitedEmail: "ops@slugbase.test",
      role: "operator",
      expiresAt: new Date("2026-06-28T00:00:00.000Z"),
    });

    expect(rendered.subject).toContain("operator portal");
    expect(rendered.text).toContain("operator");
    expect(rendered.html).toContain("accept-invite?token=abc");
    expect(rendered.html).not.toContain("ops@slugbase.test");
  });
});

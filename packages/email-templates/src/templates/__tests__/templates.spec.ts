import { describe, it, expect } from "vitest";
import { renderSignupVerificationEmail } from "../SignupVerificationEmail.js";
import { renderEmailChangeVerificationEmail } from "../EmailChangeVerificationEmail.js";
import { renderPasswordResetEmail } from "../PasswordResetEmail.js";
import { renderWorkspaceInvitationEmail } from "../WorkspaceInvitationEmail.js";
import { renderContactFormNotificationEmail } from "../ContactFormNotificationEmail.js";
import { renderMailTransportTestEmail } from "../MailTransportTestEmail.js";

describe("SignupVerificationEmail", () => {
  it("renders HTML with CTA button and verify link", () => {
    const html = renderSignupVerificationEmail({
      verifyUrl: "https://app.slugbase.app/auth/verify?token=abc123",
      name: "Alice",
    });
    expect(html).toContain("Verify email address");
    expect(html).toContain("https://app.slugbase.app/auth/verify?token=abc123");
    expect(html).toContain("Hi Alice");
    expect(html).toContain("24 hours");
  });

  it("renders without optional name", () => {
    const html = renderSignupVerificationEmail({
      verifyUrl: "https://app.slugbase.app/auth/verify?token=abc123",
    });
    expect(html).toContain("Hi there");
    expect(html).toContain("Verify email address");
  });
});

describe("EmailChangeVerificationEmail", () => {
  it("renders HTML with new email and CTA link", () => {
    const html = renderEmailChangeVerificationEmail({
      verifyUrl: "https://app.slugbase.app/auth/change-email?token=xyz",
      newEmail: "new@example.com",
    });
    expect(html).toContain("Confirm new email");
    expect(html).toContain("https://app.slugbase.app/auth/change-email?token=xyz");
    expect(html).toContain("new@example.com");
    expect(html).toContain("24 hours");
  });
});

describe("PasswordResetEmail", () => {
  it("renders HTML with reset link and safety note", () => {
    const html = renderPasswordResetEmail({
      resetUrl: "https://app.slugbase.app/auth/reset?token=reset123",
      name: "Bob",
    });
    expect(html).toContain("Reset password");
    expect(html).toContain("https://app.slugbase.app/auth/reset?token=reset123");
    expect(html).toContain("Hi Bob");
    expect(html).toContain("1 hour");
    expect(html).toContain("will not be changed");
  });
});

describe("WorkspaceInvitationEmail", () => {
  it("renders HTML with inviter, workspace, role, and accept link", () => {
    const html = renderWorkspaceInvitationEmail({
      acceptUrl: "https://app.slugbase.app/invitations/accept?id=42",
      inviterName: "Charlie",
      workspaceName: "Acme Team",
      role: "Admin",
    });
    expect(html).toContain("Accept invitation");
    expect(html).toContain("https://app.slugbase.app/invitations/accept?id=42");
    expect(html).toContain("Charlie");
    expect(html).toContain("Acme Team");
    expect(html).toContain("Admin");
    expect(html).toContain("7 days");
  });
});

describe("MailTransportTestEmail", () => {
  it("renders HTML with transport success confirmation", () => {
    const html = renderMailTransportTestEmail();
    expect(html).toContain("Mail transport test");
    expect(html).toContain("This is a test message from SlugBase");
    expect(html).toContain("mail transport is working correctly");
  });
});

describe("ContactFormNotificationEmail", () => {
  it("renders HTML with submitter info and message", () => {
    const html = renderContactFormNotificationEmail({
      name: "Dave",
      email: "dave@example.com",
      topic: "Question about pricing",
      message: "What plans are available?",
    });
    expect(html).toContain("Contact form submission");
    expect(html).toContain("Dave");
    expect(html).toContain("dave@example.com");
    expect(html).toContain("Question about pricing");
    expect(html).toContain("What plans are available?");
  });
});

describe("branding consistency", () => {
  const templates = [
    renderSignupVerificationEmail({
      verifyUrl: "https://example.com/verify",
    }),
    renderEmailChangeVerificationEmail({
      verifyUrl: "https://example.com/change",
      newEmail: "a@b.com",
    }),
    renderPasswordResetEmail({
      resetUrl: "https://example.com/reset",
    }),
    renderWorkspaceInvitationEmail({
      acceptUrl: "https://example.com/accept",
      inviterName: "Test",
      workspaceName: "WS",
      role: "Member",
    }),
    renderContactFormNotificationEmail({
      name: "T",
      email: "t@t.com",
      topic: "T",
      message: "M",
    }),
    renderMailTransportTestEmail(),
  ];

  it("all templates use dark canvas background", () => {
    for (const html of templates) {
      expect(html).toContain("#0a0b10");
    }
  });

  it("all templates use periwinkle accent for CTAs", () => {
    // Contact form notification is informational (no CTA) so no accent hex
    const ctaTemplates = templates.filter((_, i) => i < 4);
    for (const html of ctaTemplates) {
      expect(html).toContain("#7782f7");
    }
  });

  it("all templates include SlugBase logo img tag", () => {
    for (const html of templates) {
      expect(html).toContain('src="cid:slugbase-logo"');
    }
  });

  it("all templates include the footer disclaimer", () => {
    for (const html of templates) {
      expect(html).toContain("safely ignore it");
    }
  });
});

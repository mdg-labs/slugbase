export interface OperatorInviteEmailInput {
  inviteUrl: string;
  invitedEmail: string;
  role: string;
  expiresAt: Date;
}

export function renderOperatorInviteEmail(
  input: OperatorInviteEmailInput,
): { subject: string; text: string; html: string } {
  const expiresLabel = input.expiresAt.toISOString();
  const subject = "SlugBase operator portal invitation";

  const text = [
    "You have been invited to the SlugBase Cloud operator portal.",
    "",
    `Role: ${input.role}`,
    `Accept invitation: ${input.inviteUrl}`,
    `Expires: ${expiresLabel}`,
    "",
    "This link is for SlugBase platform operators only — not workspace admin access.",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
    <p>You have been invited to the <strong>SlugBase Cloud operator portal</strong>.</p>
    <p><strong>Role:</strong> ${escapeHtml(input.role)}</p>
    <p><a href="${escapeHtml(input.inviteUrl)}">Accept invitation</a></p>
    <p style="font-size: 0.9em; color: #444;">Expires: ${escapeHtml(expiresLabel)}</p>
    <p style="font-size: 0.85em; color: #666;">Platform operator access only — not workspace admin.</p>
  </body>
</html>`;

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

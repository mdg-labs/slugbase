/**
 * Workspace invitation email template.
 *
 * Sent when a workspace admin invites a member. Shows the inviter name,
 * workspace name, assigned role, and an accept CTA (7-day expiry).
 */

import {
  renderLayout,
  renderCtaButton,
  renderHeading,
  renderParagraph,
  renderRoleBadge,
  renderNote,
  renderDivider,
} from "../components/EmailLayout.js";

export interface WorkspaceInvitationEmailProps {
  /** The URL the invitee must click to accept the invitation. */
  acceptUrl: string;
  /** Display name of the person who sent the invitation. */
  inviterName: string;
  /** Name of the workspace the invitee is being added to. */
  workspaceName: string;
  /** The role the invitee will receive (e.g. "Admin", "Member"). */
  role: string;
}

export function renderWorkspaceInvitationEmail(
  props: WorkspaceInvitationEmailProps,
): string {
  const body = `
    ${renderHeading("You've been invited")}
    ${renderParagraph(
      `<strong style="color:#eceef6;">${props.inviterName}</strong> invited you to join <strong style="color:#eceef6;">${props.workspaceName}</strong> on SlugBase.`,
    )}
    ${renderRoleBadge(props.role)}
    ${renderDivider()}
    ${renderCtaButton(props.acceptUrl, "Accept invitation")}
    ${renderNote("This invitation expires in 7 days.")}
  `;

  return renderLayout({ children: body, title: "Workspace invitation" });
}

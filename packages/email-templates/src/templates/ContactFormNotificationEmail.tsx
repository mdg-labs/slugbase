/**
 * Contact form notification email template.
 *
 * Sent to the workspace admin/operator when a user submits the public
 * contact form. Contains the submitter's name, email, topic, and message.
 */

import {
  renderLayout,
  renderHeading,
  renderParagraph,
  renderDivider,
} from "../components/EmailLayout.js";

export interface ContactFormNotificationEmailProps {
  /** Submitter's display name. */
  name: string;
  /** Submitter's email address. */
  email: string;
  /** Topic or subject of the contact form submission. */
  topic: string;
  /** The message body submitted via the contact form. */
  message: string;
}

export function renderContactFormNotificationEmail(
  props: ContactFormNotificationEmailProps,
): string {
  const body = `
    ${renderHeading("Contact form submission")}
    ${renderParagraph(
      `You received a new message from <strong style="color:#eceef6;">${props.name}</strong> (${props.email}).`,
    )}
    ${renderDivider()}
    ${renderParagraph(`<strong style="color:#eceef6;">Topic:</strong> ${props.topic}`)}
    ${renderParagraph(
      `<strong style="color:#eceef6;">Message:</strong><br/>${props.message}`,
    )}
  `;

  return renderLayout({
    children: body,
    title: "Contact form submission",
  });
}

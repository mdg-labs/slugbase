import type { MailMessage } from "@slugbase/core";

/** What a template renders a message into: the subject and the text and HTML parts of one multipart message. */
export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Extra header lines, such as `List-Unsubscribe`. The headers the adapter sets itself cannot be replaced. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MailTemplateInput {
  readonly data: MailMessage["data"];
  readonly locale: string;
}

/** Renders the message a template names; the template owns the subject and both parts. */
export type MailTemplate = (input: MailTemplateInput) => RenderedMail;

/** The templates the adapter can send, by the name `MailMessage.template` carries. */
export type MailTemplates = Readonly<Record<string, MailTemplate>>;

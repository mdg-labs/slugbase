/** What a template renders a message into: the subject and the text and HTML parts of one multipart message. */
export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface MailTemplateInput {
  readonly data: Readonly<Record<string, string | number | boolean>>;
  readonly locale: string;
}

/** Renders the message a template names; it is the shape the mail adapter's templates have. */
export type MailTemplate = (input: MailTemplateInput) => RenderedMail;

/** The templates, by the name `MailMessage.template` carries. */
export type MailTemplates = Readonly<Record<string, MailTemplate>>;

import { escapeHtml } from "../html.ts";
import { BUTTON_STYLE, PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator, type Translate } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const MFA_ENABLED_TEMPLATE = "mfaEnabled";
export const MFA_DISABLED_TEMPLATE = "mfaDisabled";
export const MFA_RESET_TEMPLATE = "mfaReset";

/** Where the messages lead: the security settings of the account, on the deployment's own origin. */
const SECURITY_PATH = "/settings/account/security";

export interface MfaNotificationOptions {
  readonly appName: string;
  /** `APP_ORIGIN`: the only origin a link of the message points to. */
  readonly origin: string;
}

interface MfaMessage {
  readonly subject: string;
  readonly greeting: string;
  readonly body: string;
  readonly notYou: string;
  readonly action: string;
}

/** The catalog text of one message, in the language of `t`; `displayName` is empty when the account has none. */
type MfaCopy = (t: Translate, displayName: string, appName: string) => MfaMessage;

const ENABLED_COPY: MfaCopy = (t, displayName, appName) => ({
  subject: t("mfaEnabled.subject", { appName }),
  greeting: displayName === "" ? t("mfaEnabled.greetingAnonymous") : t("mfaEnabled.greeting", { name: displayName }),
  body: t("mfaEnabled.body", { appName }),
  notYou: t("mfaEnabled.notYou", { appName }),
  action: t("mfaEnabled.action"),
});

const DISABLED_COPY: MfaCopy = (t, displayName, appName) => ({
  subject: t("mfaDisabled.subject", { appName }),
  greeting: displayName === "" ? t("mfaDisabled.greetingAnonymous") : t("mfaDisabled.greeting", { name: displayName }),
  body: t("mfaDisabled.body", { appName }),
  notYou: t("mfaDisabled.notYou", { appName }),
  action: t("mfaDisabled.action"),
});

const RESET_COPY: MfaCopy = (t, displayName, appName) => ({
  subject: t("mfaReset.subject", { appName }),
  greeting: displayName === "" ? t("mfaReset.greetingAnonymous") : t("mfaReset.greeting", { name: displayName }),
  body: t("mfaReset.body", { appName }),
  notYou: t("mfaReset.notYou", { appName }),
  action: t("mfaReset.action"),
});

/**
 * The account's display name greets the reader, the message says what changed about the second factor
 * and links to the security settings. A name that is missing or empty gives a greeting without one. The
 * message carries no secret, code or backup code.
 */
function mfaNotification(copy: MfaCopy, { appName, origin }: MfaNotificationOptions): MailTemplate {
  const link = `${origin}${SECURITY_PATH}`;
  return ({ data, locale }) => {
    const language = resolveLocale(locale);
    const t = translator(language);
    const displayName = typeof data["displayName"] === "string" ? data["displayName"].trim() : "";
    const { subject, greeting, body, notYou, action } = copy(t, displayName, appName);
    const footer = t("layout.footer", { appName });

    const content = [
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(body)}</p>`,
      `<p style="margin:0 0 24px 0">${escapeHtml(notYou)}</p>`,
      `<p style="margin:0"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a></p>`,
    ].join("\n");
    const text = [greeting, body, notYou, `${action}: ${link}`, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}

/** "Two-factor authentication was turned on" (doc 02 section 12). */
export function mfaEnabled(options: MfaNotificationOptions): MailTemplate {
  return mfaNotification(ENABLED_COPY, options);
}

/** "Two-factor authentication was turned off" (doc 02 section 12). */
export function mfaDisabled(options: MfaNotificationOptions): MailTemplate {
  return mfaNotification(DISABLED_COPY, options);
}

/** "Two-factor authentication was reset by an administrator" (doc 02 sections 2.7 and 12). */
export function mfaReset(options: MfaNotificationOptions): MailTemplate {
  return mfaNotification(RESET_COPY, options);
}

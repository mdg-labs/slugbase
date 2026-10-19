import { escapeHtml } from "../html.ts";
import { BUTTON_STYLE, PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const OWNERSHIP_TRANSFERRED_TEMPLATE = "ownershipTransferred";

export interface OwnershipTransferredOptions {
  readonly appName: string;
  /** `APP_ORIGIN`: the only origin a link of the message points to. */
  readonly origin: string;
}

/** Text of the data on one line, so that a name with a line break cannot start a header line of the subject. */
function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * "You are now an owner of a workspace" (doc 02 section 12): the recipient's display name greets the reader and
 * the message names the workspace and, when it is still known, the owner who made the change. The link opens
 * the application on the deployment's own origin. A workspace without a name is a mistake of the sender, so the
 * template refuses it instead of sending a message that names nothing.
 */
export function ownershipTransferred({ appName, origin }: OwnershipTransferredOptions): MailTemplate {
  const link = `${origin}/`;
  return ({ data, locale }) => {
    const language = resolveLocale(locale);
    const t = translator(language);
    const workspace = oneLine(data["workspaceName"]);
    if (workspace === "") {
      throw new RangeError("the ownership email needs the name of the workspace");
    }
    const previous = oneLine(data["transferredBy"]);
    const displayName = oneLine(data["displayName"]);
    const greeting = displayName === "" ? t("ownershipTransferred.greetingAnonymous") : t("ownershipTransferred.greeting", { name: displayName });
    const subject = t("ownershipTransferred.subject", { appName, workspace });
    const body =
      previous === ""
        ? t("ownershipTransferred.body", { appName, workspace })
        : t("ownershipTransferred.bodyBy", { appName, workspace, owner: previous });
    const powers = t("ownershipTransferred.powers");
    const notExpected = t("ownershipTransferred.notExpected");
    const action = t("ownershipTransferred.action", { appName });
    const footer = t("ownershipTransferred.footer", { appName, workspace });

    const content = [
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(body)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(powers)}</p>`,
      `<p style="margin:0 0 24px 0">${escapeHtml(notExpected)}</p>`,
      `<p style="margin:0"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a></p>`,
    ].join("\n");
    const text = [greeting, body, powers, notExpected, `${action}: ${link}`, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}

import { escapeHtml } from "../html.ts";
import { BUTTON_STYLE, PARAGRAPH_STYLE, layout } from "../layout.ts";
import { resolveLocale, translator } from "../translate.ts";
import type { MailTemplate } from "../types.ts";

export const INVITATION_TEMPLATE = "invitation";

/** Where the link leads: the invitation page of the application, on the deployment's own origin. */
const INVITE_PATH = "/invite/";

/** The token as the core makes it: 32 bytes as 43 unpadded base64url characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The roles an invitation grants, which the catalogs name. */
const ROLES = ["admin", "member", "owner"] as const;

/** The day the link stops working, as the date the core hands over. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export interface InvitationOptions {
  readonly appName: string;
  /** `APP_ORIGIN`: the only origin a link of the message points to. */
  readonly origin: string;
}

/** Text of the data on one line, so that a name with a line break cannot start a header line of the subject. */
function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * The invitation email (doc 02 section 3.4): names the workspace, the person who invited and the role the
 * invitation grants, and links to `/invite/<token>` on the deployment's origin. The message goes to an address
 * that may have no account, so it greets nobody by name. The workspace and the inviter are other people's data,
 * so they are escaped and kept on one line; an inviter who is no longer known is left out of the message. A
 * token that is not the shape the core makes, a role the catalogs do not name, a workspace without a name or
 * a date that is not a date is refused, so no message goes out that names nothing or links to nothing that works.
 */
export function invitation({ appName, origin }: InvitationOptions): MailTemplate {
  return ({ data, locale }) => {
    const token = data["token"];
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
      throw new RangeError("the invitation email needs the 43-character token of its link");
    }
    const role = ROLES.find((candidate) => candidate === data["role"]);
    if (role === undefined) {
      throw new RangeError("the invitation email needs the role the invitation grants: admin, member or owner");
    }
    const workspace = oneLine(data["workspaceName"]);
    if (workspace === "") {
      throw new RangeError("the invitation email needs the name of the workspace");
    }
    const expiresOn = data["expiresOn"];
    if (typeof expiresOn !== "string" || !DATE_SHAPE.test(expiresOn)) {
      throw new RangeError("the invitation email needs the date the invitation expires on, as YYYY-MM-DD");
    }
    const inviter = oneLine(data["inviterName"]);
    const link = `${origin}${INVITE_PATH}${token}`;
    const language = resolveLocale(locale);
    const t = translator(language);
    const roleName = role === "owner" ? t("invitation.role.owner") : role === "admin" ? t("invitation.role.admin") : t("invitation.role.member");
    const subject =
      inviter === "" ? t("invitation.subject", { appName, workspace }) : t("invitation.subjectBy", { appName, workspace, inviter });
    const greeting = t("invitation.greeting");
    const body =
      inviter === ""
        ? t("invitation.body", { appName, workspace, role: roleName })
        : t("invitation.bodyBy", { appName, workspace, role: roleName, inviter });
    const expiry = t("invitation.expiry", { date: expiresOn });
    const notExpected = t("invitation.notExpected");
    const action = t("invitation.action");
    const footer = t("invitation.footer", { appName, workspace });

    const content = [
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(greeting)}</p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(body)}</p>`,
      `<p style="margin:0 0 24px 0"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a></p>`,
      `<p style="${PARAGRAPH_STYLE}">${escapeHtml(expiry)}</p>`,
      `<p style="margin:0">${escapeHtml(notExpected)}</p>`,
    ].join("\n");
    const text = [greeting, body, `${action}: ${link}`, expiry, notExpected, footer].join("\n\n");
    return { subject, text: `${text}\n`, html: layout({ locale: language, title: subject, appName, footer, content }) };
  };
}

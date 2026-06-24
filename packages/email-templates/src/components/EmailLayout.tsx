import { SLUGBASE_LOGO_CID } from "../logo.js";

/**
 * Shared dark-themed email layout (spec section 23, colors_and_type.css tokens).
 *
 * Wraps every transactional email in a consistent branded shell:
 * - Canvas background (#0a0b10)
 * - Raised card (#171a2b, 12px radius)
 * - Periwinkle accent CTAs (#7782f7)
 * - IBM Plex Sans font stack
 * - Logo slot at top
 * - Muted footer
 */

const COLORS = {
  canvas: "#0a0b10",
  raised: "#171a2b",
  raisedBorder: "rgba(255, 255, 255, 0.10)",
  accent: "#7782f7",
  accentHover: "#8d96f9",
  accentFg: "#0b0c14",
  fg: "#eceef6",
  fgMuted: "#a7adc2",
  fgSubtle: "#6e7489",
  footerBg: "#101220",
} as const;

const FONT_STACK =
  "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";

export interface EmailLayoutProps {
  /** Pre-rendered inner HTML (the template body). */
  children: string;
  /** Page title used in the <title> tag (hidden in most email clients). */
  title?: string;
}

/**
 * Wraps template content in a dark-themed, single-column email shell.
 * All styles are inlined for maximum email client compatibility.
 */
export function renderLayout({ children, title }: EmailLayoutProps): string {
  const pageTitle = title ?? "SlugBase";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>${pageTitle}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${COLORS.canvas};font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.canvas};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <img
                src="cid:${SLUGBASE_LOGO_CID}"
                alt="SlugBase"
                width="48"
                height="48"
                style="display:block;border:0;outline:none;"
              />
            </td>
          </tr>
          <!-- Card -->
          <tr>
            <td style="background-color:${COLORS.raised};border:1px solid ${COLORS.raisedBorder};border-radius:12px;padding:32px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${children}
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding:24px 16px 0;">
              <p style="margin:0 0 8px;font-size:12px;line-height:16px;color:${COLORS.fgSubtle};font-family:${FONT_STACK};">
                If you did not expect this email, you can safely ignore it.
              </p>
              <p style="margin:0;font-size:11px;line-height:14px;color:${COLORS.fgSubtle};font-family:${FONT_STACK};">
                SlugBase &mdash; Bookmark manager &amp; URL shortener
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Renders a primary CTA button (table-based for email client support).
 */
export function renderCtaButton(href: string, label: string): string {
  return `
    <tr>
      <td align="center" style="padding:24px 0 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="background-color:${COLORS.accent};border-radius:6px;">
              <a
                href="${href}"
                target="_blank"
                style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;line-height:20px;color:${COLORS.accentFg};text-decoration:none;font-family:${FONT_STACK};"
              >${label}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/**
 * Renders a heading row inside the card.
 */
export function renderHeading(text: string): string {
  return `
    <tr>
      <td style="padding:0 0 16px;">
        <h1 style="margin:0;font-size:22px;font-weight:600;line-height:28px;color:${COLORS.fg};font-family:${FONT_STACK};">${text}</h1>
      </td>
    </tr>`;
}

/**
 * Renders a paragraph row inside the card.
 */
export function renderParagraph(
  text: string,
  options?: { color?: string },
): string {
  const color = options?.color ?? COLORS.fgMuted;
  return `
    <tr>
      <td style="padding:0 0 16px;">
        <p style="margin:0;font-size:14px;line-height:22px;color:${color};font-family:${FONT_STACK};">${text}</p>
      </td>
    </tr>`;
}

/**
 * Renders a small muted note (e.g. expiry warnings).
 */
export function renderNote(text: string): string {
  return `
    <tr>
      <td style="padding:0 0 16px;">
        <p style="margin:0;font-size:12px;line-height:16px;color:${COLORS.fgSubtle};font-family:${FONT_STACK};">${text}</p>
      </td>
    </tr>`;
}

/**
 * Renders a role badge (for invitation emails).
 */
export function renderRoleBadge(role: string): string {
  return `
    <tr>
      <td style="padding:0 0 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="background-color:${COLORS.accent}22;border:1px solid ${COLORS.accent};border-radius:4px;padding:4px 12px;">
              <span style="font-size:12px;font-weight:600;line-height:16px;color:${COLORS.accent};font-family:${FONT_STACK};text-transform:uppercase;letter-spacing:0.06em;">${role}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/**
 * Renders a horizontal divider line.
 */
export function renderDivider(): string {
  return `
    <tr>
      <td style="padding:0 0 16px;">
        <hr style="border:none;border-top:1px solid ${COLORS.raisedBorder};margin:0;" />
      </td>
    </tr>`;
}

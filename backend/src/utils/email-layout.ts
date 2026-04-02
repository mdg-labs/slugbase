/**
 * Transactional email shell + design tokens aligned with frontend Obsidian palette
 * (see frontend/src/index.css :root and .dark). Hex values are email-safe approximations
 * of HSL tokens (e.g. --primary 235 84.6% 64.3%, card surface 0 0% 9.8%).
 */

/** Masthead: Obsidian dark card surface hsl(0, 0%, 9.8%) */
export const EMAIL_HEADER_BG = '#191919';

/** Light mode primary / buttons / links: hsl(235, 84.6%, 64.3%) */
export const EMAIL_PRIMARY = '#5764f1';

/** For box-shadow on primary buttons */
export const EMAIL_PRIMARY_SHADOW = '0 2px 4px rgba(87, 100, 241, 0.35)';

/** Outer page background: hsl(240, 11.1%, 96.5%) */
export const EMAIL_PAGE_BG = '#f5f5f7';

/** Soft callout (info / expiry notices), purple-tinted */
export const EMAIL_CALLOUT_BG = '#eef0ff';
export const EMAIL_CALLOUT_BORDER = EMAIL_PRIMARY;
export const EMAIL_CALLOUT_TEXT = '#3730a3';

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getFrontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export interface BuildEmailLayoutOptions {
  contentHtml: string;
  title?: string;
  footerMessage?: string;
  includeLegalFooter?: boolean;
}

/**
 * Consistent email layout: header (logo + wordmark), content, footer.
 */
export function buildEmailLayout(options: BuildEmailLayoutOptions): string {
  const {
    contentHtml,
    title = 'SlugBase',
    footerMessage = 'This is an automated message from SlugBase. Please do not reply to this email.',
    includeLegalFooter = false,
  } = options;
  const frontendUrl = getFrontendUrl();
  const logoUrl = `${frontendUrl}/slugbase_icon_purple.png`;

  const legalFooterHtml = includeLegalFooter
    ? ` &middot; <a href="${frontendUrl}/imprint" style="color: #6b7280; text-decoration: underline;">Imprint</a> &middot; <a href="${frontendUrl}/privacy" style="color: #6b7280; text-decoration: underline;">Privacy</a>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(title)}</title>
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
<body style="margin: 0; padding: 0; background-color: ${EMAIL_PAGE_BG}; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: ${EMAIL_PAGE_BG};">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 40px; text-align: center; background-color: ${EMAIL_HEADER_BG}; border-radius: 8px 8px 0 0;">
              <img src="${logoUrl}" alt="SlugBase" width="40" height="40" style="display: inline-block; vertical-align: middle; margin-right: 10px;" />
              <h1 style="margin: 0; display: inline-block; vertical-align: middle; color: #ffffff; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">SlugBase</h1>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              ${contentHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6; text-align: center;">${footerMessage}${legalFooterHtml}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

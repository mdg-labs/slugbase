import nodemailer from 'nodemailer';
import { queryOne } from '../db/index.js';
import { decrypt } from './encryption.js';
import { isCloud } from '../config/mode.js';

/**
 * Escape HTML to prevent XSS attacks
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate and escape URL for safe use in HTML href attributes
 * Note: href attributes need the URL as-is (not HTML-escaped) but display text should be escaped
 */
function safeUrlForHref(url: string): string {
  // URL should already be validated before being passed here
  // For href attributes, we can use the URL directly since it's validated
  // But we'll double-check it doesn't contain javascript: or data: protocols
  const lowerUrl = url.toLowerCase().trim();
  if (lowerUrl.startsWith('javascript:') || lowerUrl.startsWith('data:') || lowerUrl.startsWith('vbscript:')) {
    // This should never happen if validation is working, but be defensive
    return '#';
  }
  return url;
}

/** Email header background: same navy as app dark mode (#0b162A) */
const HEADER_BG = '#0b162A';
/** Accent color for buttons and links: app primary orange (#E64100) */
const ACCENT_ORANGE = '#E64100';

function getFrontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

interface BuildEmailLayoutOptions {
  contentHtml: string;
  title?: string;
  footerMessage?: string;
  includeLegalFooter?: boolean;
}

/**
 * Build a consistent email layout with header (logo + SlugBase), content, and footer.
 */
function buildEmailLayout(options: BuildEmailLayoutOptions): string {
  const {
    contentHtml,
    title = 'SlugBase',
    footerMessage = 'This is an automated message from SlugBase. Please do not reply to this email.',
    includeLegalFooter = false,
  } = options;
  const frontendUrl = getFrontendUrl();
  const logoUrl = `${frontendUrl}/slugbase_icon_white.png`;

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
<body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 40px; text-align: center; background-color: ${HEADER_BG}; border-radius: 8px 8px 0 0;">
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

interface SMTPConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    password: string; // Internal use, will be converted to 'pass' for nodemailer
  };
  from: string;
  fromName: string;
}

/**
 * Get SMTP configuration from system settings (SELFHOSTED only).
 * Returns config object or null with error message.
 */
async function getSMTPConfig(): Promise<{ config: SMTPConfig | null; error?: string }> {
  try {
    const enabled = await queryOne('SELECT value FROM system_config WHERE key = ?', ['smtp_enabled']);
    if (!enabled || (enabled as any).value !== 'true') {
      return { config: null, error: 'SMTP is not enabled' };
    }

    const host = await queryOne('SELECT value FROM system_config WHERE key = ?', ['smtp_host']);
    const port = await queryOne('SELECT value FROM system_config WHERE key = ?', ['smtp_port']);
    const secure = await queryOne('SELECT value FROM system_config WHERE key = ?', ['smtp_secure']);
    const user = await queryOne('SELECT value FROM system_config WHERE key = ?', ['smtp_user']);
    const password = await queryOne('SELECT value FROM system_config WHERE key = ?', ['smtp_password']);
    const from = await queryOne('SELECT value FROM system_config WHERE key = ?', ['smtp_from']);
    const fromName = await queryOne('SELECT value FROM system_config WHERE key = ?', ['smtp_from_name']);

    if (!host) return { config: null, error: 'SMTP host is not configured' };
    if (!port) return { config: null, error: 'SMTP port is not configured' };
    if (!user) return { config: null, error: 'SMTP user is not configured' };
    if (!password) return { config: null, error: 'SMTP password is not configured' };
    if (!from) return { config: null, error: 'SMTP from email is not configured' };

    const hostValue = String((host as any).value).trim();
    const userValue = String((user as any).value).trim();
    const passwordValue = String((password as any).value).trim();
    const fromValue = String((from as any).value).trim();

    if (!hostValue) return { config: null, error: 'SMTP host is empty' };
    if (!userValue) return { config: null, error: 'SMTP user is empty' };
    if (!passwordValue) return { config: null, error: 'SMTP password is empty' };
    if (!fromValue) return { config: null, error: 'SMTP from email is empty' };

    let decryptedPassword = passwordValue;
    try {
      decryptedPassword = decrypt(passwordValue);
    } catch (error: any) {
      console.warn('SMTP credential decryption failed, using stored value:', error.message);
      decryptedPassword = passwordValue;
    }

    const trimmedPassword = decryptedPassword ? decryptedPassword.trim() : '';
    if (!trimmedPassword) {
      console.error('SMTP credential validation failed: value is empty');
      return { config: null, error: 'SMTP password is empty. Please set a password in the SMTP settings.' };
    }

    return {
      config: {
        host: hostValue,
        port: parseInt(String((port as any).value)) || 587,
        secure: (secure as any)?.value === 'true' || false,
        auth: { user: userValue, password: trimmedPassword },
        from: fromValue,
        fromName: String((fromName as any)?.value || 'SlugBase'),
      },
    };
  } catch (error: any) {
    console.error('Error getting SMTP config:', error);
    return { config: null, error: `Error retrieving SMTP config: ${error.message}` };
  }
}

/**
 * Whether Postmark is configured (cloud mode). Used when isCloud to send verification etc.
 */
function isPostmarkConfigured(): boolean {
  const apiKey = process.env.POSTMARK_API_KEY?.trim();
  const fromEmail = process.env.POSTMARK_FROM_EMAIL?.trim();
  return Boolean(isCloud && apiKey && fromEmail);
}

/**
 * Send email via Postmark API (cloud mode). No dependency on postmark package; uses fetch.
 */
async function sendEmailViaPostmark(
  to: string,
  subject: string,
  html: string,
  text?: string
): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.POSTMARK_API_KEY?.trim();
  const fromEmail = process.env.POSTMARK_FROM_EMAIL?.trim();
  const fromName = (process.env.POSTMARK_FROM_NAME || 'SlugBase').trim();
  if (!apiKey || !fromEmail) {
    return { success: false, error: 'Postmark is not configured (missing POSTMARK_API_KEY or POSTMARK_FROM_EMAIL)' };
  }
  const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
  const textBody = text || html.replace(/<[^>]+>/g, '').slice(0, 100000);
  try {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': apiKey,
      },
      body: JSON.stringify({
        From: from,
        To: to.trim(),
        Subject: subject,
        HtmlBody: html,
        TextBody: textBody,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Postmark API error:', res.status, body);
      return { success: false, error: `Postmark: ${res.status} ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { MessageID?: string };
    console.log('Email sent via Postmark:', data.MessageID);
    return { success: true };
  } catch (err: any) {
    console.error('Postmark send error:', err);
    return { success: false, error: err?.message || 'Postmark send failed' };
  }
}

/**
 * Returns whether email sending is available (SMTP or Postmark configured).
 * Used e.g. to show "Send invite" when adding users.
 */
export async function isEmailSendingAvailable(): Promise<boolean> {
  if (isPostmarkConfigured()) return true;
  const { config } = await getSMTPConfig();
  return config != null;
}

/**
 * Send email using SMTP (self-hosted) or Postmark (cloud when configured).
 */
export async function sendEmail(to: string, subject: string, html: string, text?: string): Promise<{ success: boolean; error?: string }> {
  if (isPostmarkConfigured()) {
    const result = await sendEmailViaPostmark(to, subject, html, text);
    if (!result.success) {
      console.error('Send email (Postmark) failed:', result.error);
    }
    return result;
  }
  try {
    const { config, error } = await getSMTPConfig();
    if (!config) {
      const msg = error || 'SMTP not configured or not enabled';
      console.error('Send email failed:', msg);
      return { success: false, error: msg };
    }

    // Validate auth credentials before creating transporter
    if (!config.auth || !config.auth.user || !config.auth.password) {
      return { success: false, error: 'SMTP auth credentials are missing' };
    }

    const authUser = config.auth.user.trim();
    const authPassword = config.auth.password.trim();

    if (!authUser || !authPassword) {
      console.error('SMTP auth validation failed: credentials are empty');
      return { success: false, error: 'SMTP auth credentials are empty' };
    }

    const transportConfig = {
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: authUser, pass: authPassword },
    };

    console.log('Creating SMTP transporter with:', { host: config.host, port: config.port, secure: config.secure });
    const transporter = nodemailer.createTransport(transportConfig);

    const stripHtml = (htmlContent: string): string => {
      if (htmlContent.length > 100000) htmlContent = htmlContent.substring(0, 100000);
      return htmlContent.replace(/<[^>]{0,1000}>/g, '');
    };

    const info = await transporter.sendMail({
      from: `"${config.fromName}" <${config.from}>`,
      to,
      subject,
      text: text || stripHtml(html),
      html,
    });

    console.log('Email sent:', info.messageId);
    return { success: true };
  } catch (error: any) {
    console.error('Error sending email:', error);
    return { success: false, error: error.message || 'Unknown error sending email' };
  }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(email: string, resetToken: string, resetUrl: string): Promise<boolean> {
  const safeHrefUrl = safeUrlForHref(resetUrl);
  const escapedDisplayUrl = escapeHtml(resetUrl);

  const subject = 'Password Reset Request - SlugBase';
  const contentHtml = `
    <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600; line-height: 1.3;">Password Reset Request</h2>
    <p style="margin: 0 0 20px; color: #4a4a4a; font-size: 16px; line-height: 1.6;">You requested to reset your password for your SlugBase account. Click the button below to create a new password:</p>
    
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 30px 0;">
      <tr>
        <td align="center" style="padding: 0;">
          <a href="${safeHrefUrl}" style="display: inline-block; padding: 14px 32px; background-color: ${ACCENT_ORANGE}; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center; box-shadow: 0 2px 4px rgba(230, 65, 0, 0.3);">Reset Password</a>
        </td>
      </tr>
    </table>
    
    <p style="margin: 20px 0; color: #6b7280; font-size: 14px; line-height: 1.6;">Or copy and paste this link into your browser:</p>
    <p style="margin: 0 0 30px; padding: 12px; background-color: #f9fafb; border-radius: 4px; word-break: break-all; color: #4a4a4a; font-size: 13px; font-family: 'Courier New', monospace; line-height: 1.5;">${escapedDisplayUrl}</p>
    
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 30px 0; background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px;">
      <tr>
        <td style="padding: 16px;">
          <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.6; font-weight: 500;">⚠️ This link will expire in 1 hour for security reasons.</p>
        </td>
      </tr>
    </table>
    
    <p style="margin: 30px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">If you did not request a password reset, please ignore this email. Your password will remain unchanged.</p>
  `;

  const html = buildEmailLayout({
    contentHtml,
    title: 'Password Reset Request',
    includeLegalFooter: true,
  });

  const result = await sendEmail(email, subject, html);
  return result.success;
}

/**
 * Send invite email (admin-invited user: set password link).
 * Uses same link shape as password reset (/reset-password?token=...).
 */
export async function sendInviteEmail(
  email: string,
  setPasswordUrl: string,
  recipientName?: string
): Promise<boolean> {
  const safeHrefUrl = safeUrlForHref(setPasswordUrl);
  const escapedDisplayUrl = escapeHtml(setPasswordUrl);
  const greeting = recipientName
    ? `Hi ${escapeHtml(recipientName)},<br><br>`
    : '';

  const subject = "You're invited to SlugBase";
  const contentHtml = `
    <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600; line-height: 1.3;">You're invited to SlugBase</h2>
    <p style="margin: 0 0 20px; color: #4a4a4a; font-size: 16px; line-height: 1.6;">${greeting}You've been invited to join SlugBase. Click the button below to set your password and get started:</p>
    
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 30px 0;">
      <tr>
        <td align="center" style="padding: 0;">
          <a href="${safeHrefUrl}" style="display: inline-block; padding: 14px 32px; background-color: ${ACCENT_ORANGE}; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center; box-shadow: 0 2px 4px rgba(230, 65, 0, 0.3);">Set password</a>
        </td>
      </tr>
    </table>
    
    <p style="margin: 20px 0; color: #6b7280; font-size: 14px; line-height: 1.6;">Or copy and paste this link into your browser:</p>
    <p style="margin: 0 0 30px; padding: 12px; background-color: #f9fafb; border-radius: 4px; word-break: break-all; color: #4a4a4a; font-size: 13px; font-family: 'Courier New', monospace; line-height: 1.5;">${escapedDisplayUrl}</p>
    
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 30px 0; background-color: #fff7ed; border-left: 4px solid ${ACCENT_ORANGE}; border-radius: 4px;">
      <tr>
        <td style="padding: 16px;">
          <p style="margin: 0; color: #9a3412; font-size: 14px; line-height: 1.6; font-weight: 500;">This link will expire in 7 days.</p>
        </td>
      </tr>
    </table>
    
    <p style="margin: 30px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">If you did not expect this invite, you can ignore this email.</p>
  `;

  const html = buildEmailLayout({
    contentHtml,
    title: "You're invited to SlugBase",
    includeLegalFooter: true,
  });

  const result = await sendEmail(email, subject, html);
  return result.success;
}

/**
 * Send email verification email
 */
export async function sendEmailVerificationEmail(email: string, verificationToken: string, verificationUrl: string, newEmail: string): Promise<boolean> {
  const safeHrefUrl = safeUrlForHref(verificationUrl);
  const escapedDisplayUrl = escapeHtml(verificationUrl);
  const escapedNewEmail = escapeHtml(newEmail);

  const subject = 'Verify Your New Email Address - SlugBase';
  const contentHtml = `
    <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600; line-height: 1.3;">Verify Your New Email Address</h2>
    <p style="margin: 0 0 20px; color: #4a4a4a; font-size: 16px; line-height: 1.6;">You requested to change your email address to <strong style="color: #1a1a1a;">${escapedNewEmail}</strong>. Click the button below to verify and complete the change:</p>
    
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 30px 0;">
      <tr>
        <td align="center" style="padding: 0;">
          <a href="${safeHrefUrl}" style="display: inline-block; padding: 14px 32px; background-color: ${ACCENT_ORANGE}; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center; box-shadow: 0 2px 4px rgba(230, 65, 0, 0.3);">Verify Email Address</a>
        </td>
      </tr>
    </table>
    
    <p style="margin: 20px 0; color: #6b7280; font-size: 14px; line-height: 1.6;">Or copy and paste this link into your browser:</p>
    <p style="margin: 0 0 30px; padding: 12px; background-color: #f9fafb; border-radius: 4px; word-break: break-all; color: #4a4a4a; font-size: 13px; font-family: 'Courier New', monospace; line-height: 1.5;">${escapedDisplayUrl}</p>
    
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 30px 0; background-color: #fff7ed; border-left: 4px solid ${ACCENT_ORANGE}; border-radius: 4px;">
      <tr>
        <td style="padding: 16px;">
          <p style="margin: 0; color: #9a3412; font-size: 14px; line-height: 1.6; font-weight: 500;">ℹ️ This link will expire in 24 hours for security reasons.</p>
        </td>
      </tr>
    </table>
    
    <p style="margin: 30px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">If you did not request this email change, please ignore this email. Your email address will remain unchanged.</p>
  `;

  const html = buildEmailLayout({
    contentHtml,
    title: 'Verify Your New Email Address',
    includeLegalFooter: true,
  });

  const result = await sendEmail(email, subject, html);
  return result.success;
}

export interface ContactFormData {
  name: string;
  email: string;
  message: string;
}

/**
 * Send contact form confirmation to the customer
 */
export async function sendContactConfirmationEmail(email: string, name: string): Promise<boolean> {
  const escapedName = escapeHtml(name);
  const escapedEmail = escapeHtml(email);

  const subject = 'We received your message - SlugBase';
  const contentHtml = `
    <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600;">We received your message</h2>
    <p style="margin: 0 0 20px; color: #4a4a4a; font-size: 16px; line-height: 1.6;">Hi ${escapedName},</p>
    <p style="margin: 0 0 20px; color: #4a4a4a; font-size: 16px; line-height: 1.6;">Thank you for reaching out! We have received your message and will get back to you at ${escapedEmail} as soon as possible.</p>
    <p style="margin: 30px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">Best regards,<br>The SlugBase Team</p>
  `;

  const html = buildEmailLayout({
    contentHtml,
    title: 'Message Received',
    footerMessage: 'This is an automated confirmation from SlugBase.',
    includeLegalFooter: true,
  });

  const result = await sendEmail(email, subject, html);
  return result.success;
}

/**
 * Send contact form submission to the configured recipient
 */
export async function sendContactFormNotification(recipient: string, data: ContactFormData): Promise<boolean> {
  const escapedName = escapeHtml(data.name);
  const escapedEmail = escapeHtml(data.email);
  const escapedMessage = escapeHtml(data.message).replace(/\n/g, '<br>');

  const subject = `Contact Form: Message from ${escapedName}`;
  const contentHtml = `
    <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600;">New Contact Form Submission</h2>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 20px; background-color: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
      <tr>
        <td style="padding: 16px;">
          <p style="margin: 0 0 8px; color: #6b7280; font-size: 12px; font-weight: 600; text-transform: uppercase;">Name</p>
          <p style="margin: 0; color: #1a1a1a; font-size: 16px;">${escapedName}</p>
        </td>
      </tr>
      <tr>
        <td style="padding: 16px; border-top: 1px solid #e5e7eb;">
          <p style="margin: 0 0 8px; color: #6b7280; font-size: 12px; font-weight: 600; text-transform: uppercase;">Email</p>
          <p style="margin: 0;"><a href="mailto:${escapedEmail}" style="color: ${ACCENT_ORANGE}; text-decoration: none;">${escapedEmail}</a></p>
        </td>
      </tr>
      <tr>
        <td style="padding: 16px; border-top: 1px solid #e5e7eb;">
          <p style="margin: 0 0 8px; color: #6b7280; font-size: 12px; font-weight: 600; text-transform: uppercase;">Message</p>
          <p style="margin: 0; color: #1a1a1a; font-size: 16px; line-height: 1.6; white-space: pre-wrap;">${escapedMessage}</p>
        </td>
      </tr>
    </table>
    <p style="margin: 20px 0 0; color: #9ca3af; font-size: 12px;">Submitted via SlugBase contact form</p>
  `;

  const html = buildEmailLayout({
    contentHtml,
    title: 'Contact Form Submission',
    footerMessage: 'This is an automated notification from SlugBase.',
    includeLegalFooter: false,
  });

  const result = await sendEmail(recipient, subject, html);
  return result.success;
}

/**
 * Send signup verification email.
 */
export async function sendSignupVerificationEmail(email: string, verificationUrl: string): Promise<boolean> {
  const safeHrefUrl = safeUrlForHref(verificationUrl);
  const escapedDisplayUrl = escapeHtml(verificationUrl);

  const subject = 'Verify your SlugBase account';
  const contentHtml = `
    <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600;">Verify your account</h2>
    <p style="margin: 0 0 20px; color: #4a4a4a; font-size: 16px; line-height: 1.6;">Thanks for signing up. Click the button below to verify your email and start using SlugBase:</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 30px 0;">
      <tr>
        <td align="center" style="padding: 0;">
          <a href="${safeHrefUrl}" style="display: inline-block; padding: 14px 32px; background-color: ${ACCENT_ORANGE}; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; box-shadow: 0 2px 4px rgba(230, 65, 0, 0.3);">Verify email</a>
        </td>
      </tr>
    </table>
    <p style="margin: 20px 0; color: #6b7280; font-size: 14px;">Or copy and paste this link into your browser:</p>
    <p style="margin: 0 0 30px; padding: 12px; background-color: #f9fafb; border-radius: 4px; word-break: break-all; color: #4a4a4a; font-size: 13px; font-family: monospace;">${escapedDisplayUrl}</p>
    <p style="margin: 0; color: #6b7280; font-size: 14px;">This link expires in 24 hours. If you did not sign up for SlugBase, you can ignore this email.</p>
  `;

  const html = buildEmailLayout({
    contentHtml,
    title: 'Verify your SlugBase account',
    includeLegalFooter: true,
  });

  const result = await sendEmail(email, subject, html);
  return result.success;
}

/**
 * Test SMTP configuration
 */
export async function testSMTPConfig(testEmail: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { config, error } = await getSMTPConfig();
    if (!config) {
      return { success: false, error: error || 'SMTP not configured or not enabled' };
    }

    const escapedTestEmail = escapeHtml(testEmail);
    const subject = 'SMTP Test Email - SlugBase';
    const sentDate = new Date().toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    const contentHtml = `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 30px; background-color: #d1fae5; border-left: 4px solid #10b981; border-radius: 4px;">
      <tr>
        <td style="padding: 20px; text-align: center;">
          <p style="margin: 0; color: #065f46; font-size: 48px; line-height: 1;">✓</p>
        </td>
      </tr>
    </table>
    
    <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600; line-height: 1.3; text-align: center;">SMTP Configuration Test</h2>
    <p style="margin: 0 0 30px; color: #4a4a4a; font-size: 16px; line-height: 1.6; text-align: center;">If you received this email, your SMTP configuration is working correctly!</p>
    
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 30px 0; background-color: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
      <tr>
        <td style="padding: 20px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding: 0 0 12px; color: #6b7280; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Test Details</td>
            </tr>
            <tr>
              <td style="padding: 0 0 8px; color: #1a1a1a; font-size: 14px; line-height: 1.6;">
                <strong style="color: #4a4a4a;">Sent at:</strong> ${sentDate}
              </td>
            </tr>
            <tr>
              <td style="padding: 0; color: #1a1a1a; font-size: 14px; line-height: 1.6;">
                <strong style="color: #4a4a4a;">Recipient:</strong> ${escapedTestEmail}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    
    <p style="margin: 30px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6; text-align: center;">Your email server is properly configured and ready to send emails from SlugBase.</p>
    `;

    const html = buildEmailLayout({
      contentHtml,
      title: 'SMTP Test Email',
      footerMessage: 'This is a test email from SlugBase. Your SMTP configuration is working correctly.',
      includeLegalFooter: false,
    });

    const result = await sendEmail(testEmail, subject, html);
    if (result.success) {
      return { success: true };
    } else {
      return { success: false, error: result.error || 'Failed to send test email' };
    }
  } catch (error: any) {
    return { success: false, error: error.message || 'Unknown error' };
  }
}

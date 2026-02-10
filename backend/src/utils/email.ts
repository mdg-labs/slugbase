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
 * Get SMTP configuration: from environment (CLOUD) or from system settings (SELFHOSTED).
 * Returns config object or null with error message.
 */
async function getSMTPConfig(): Promise<{ config: SMTPConfig | null; error?: string }> {
  try {
    if (isCloud) {
      const enabled = process.env.SMTP_ENABLED?.toLowerCase() === 'true';
      if (!enabled) return { config: null, error: 'SMTP is not enabled (SMTP_ENABLED is not true)' };

      const host = process.env.SMTP_HOST?.trim();
      const portRaw = process.env.SMTP_PORT?.trim();
      const secure = process.env.SMTP_SECURE?.toLowerCase() === 'true';
      const user = process.env.SMTP_USER?.trim();
      const password = process.env.SMTP_PASSWORD?.trim();
      const from = process.env.SMTP_FROM?.trim();
      const fromName = process.env.SMTP_FROM_NAME?.trim() || 'SlugBase';

      if (!host) return { config: null, error: 'SMTP host is not configured (SMTP_HOST)' };
      if (!portRaw) return { config: null, error: 'SMTP port is not configured (SMTP_PORT)' };
      if (!user) return { config: null, error: 'SMTP user is not configured (SMTP_USER)' };
      if (!password) return { config: null, error: 'SMTP password is not configured (SMTP_PASSWORD)' };
      if (!from) return { config: null, error: 'SMTP from email is not configured (SMTP_FROM)' };

      const port = parseInt(portRaw, 10) || 587;
      return {
        config: {
          host,
          port,
          secure,
          auth: { user, password },
          from,
          fromName,
        },
      };
    }

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
      console.warn('SMTP password decryption failed, using as plain text:', error.message);
      decryptedPassword = passwordValue;
    }

    const trimmedPassword = decryptedPassword ? decryptedPassword.trim() : '';
    if (!trimmedPassword) {
      console.error('SMTP password validation failed: password is empty');
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
 * Send email using configured SMTP settings
 */
export async function sendEmail(to: string, subject: string, html: string, text?: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { config, error } = await getSMTPConfig();
    if (!config) {
      return { success: false, error: error || 'SMTP not configured or not enabled' };
    }

    // Validate auth credentials before creating transporter
    if (!config.auth || !config.auth.user || !config.auth.password) {
      return { success: false, error: 'SMTP auth credentials are missing' };
    }

    const authUser = config.auth.user.trim();
    const authPassword = config.auth.password.trim();

    if (!authUser || !authPassword) {
      // Don't log sensitive information like lengths or values
      console.error('SMTP auth validation failed: credentials are empty');
      return { success: false, error: 'SMTP auth credentials are empty' };
    }

    // Create transporter with auth
    const transportConfig = {
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: authUser,
        pass: authPassword, // nodemailer uses 'pass' not 'password'
      },
    };

    // Don't log sensitive information like username or password details
    console.log('Creating SMTP transporter with:', {
      host: config.host,
      port: config.port,
      secure: config.secure,
    });

    const transporter = nodemailer.createTransport(transportConfig);

    // Safe HTML stripping: use a non-catastrophic regex with bounded quantifier
    const stripHtml = (htmlContent: string): string => {
      // Limit input size to prevent ReDoS
      if (htmlContent.length > 100000) {
        htmlContent = htmlContent.substring(0, 100000);
      }
      // Use bounded quantifier {0,1000} to prevent ReDoS attacks
      return htmlContent.replace(/<[^>]{0,1000}>/g, '');
    };

    const info = await transporter.sendMail({
      from: `"${config.fromName}" <${config.from}>`,
      to,
      subject,
      text: text || stripHtml(html), // Strip HTML for text version
      html, // HTML is already escaped in template functions
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
  // Validate and sanitize URL for safe use in email
  // URL is already validated before being passed here, but we ensure it's safe for href
  const safeHrefUrl = safeUrlForHref(resetUrl);
  const escapedDisplayUrl = escapeHtml(resetUrl); // Escape for display text
  
  const subject = 'Password Reset Request - SlugBase';
  const html = `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>Password Reset Request</title>
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
            <td style="padding: 40px 40px 30px; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">SlugBase</h1>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600; line-height: 1.3;">Password Reset Request</h2>
              <p style="margin: 0 0 20px; color: #4a4a4a; font-size: 16px; line-height: 1.6;">You requested to reset your password for your SlugBase account. Click the button below to create a new password:</p>
              
              <!-- Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 30px 0;">
                <tr>
                  <td align="center" style="padding: 0;">
                    <a href="${safeHrefUrl}" style="display: inline-block; padding: 14px 32px; background-color: #667eea; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center; box-shadow: 0 2px 4px rgba(102, 126, 234, 0.3);">Reset Password</a>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 20px 0; color: #6b7280; font-size: 14px; line-height: 1.6;">Or copy and paste this link into your browser:</p>
              <p style="margin: 0 0 30px; padding: 12px; background-color: #f9fafb; border-radius: 4px; word-break: break-all; color: #4a4a4a; font-size: 13px; font-family: 'Courier New', monospace; line-height: 1.5;">${escapedDisplayUrl}</p>
              
              <!-- Warning -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 30px 0; background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.6; font-weight: 500;">⚠️ This link will expire in 1 hour for security reasons.</p>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 30px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">If you did not request a password reset, please ignore this email. Your password will remain unchanged.</p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6; text-align: center;">This is an automated message from SlugBase. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

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
  const html = `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>Verify Your New Email Address</title>
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
            <td style="padding: 40px 40px 30px; text-align: center; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">SlugBase</h1>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600; line-height: 1.3;">Verify Your New Email Address</h2>
              <p style="margin: 0 0 20px; color: #4a4a4a; font-size: 16px; line-height: 1.6;">You requested to change your email address to <strong style="color: #1a1a1a;">${escapedNewEmail}</strong>. Click the button below to verify and complete the change:</p>
              
              <!-- Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 30px 0;">
                <tr>
                  <td align="center" style="padding: 0;">
                    <a href="${safeHrefUrl}" style="display: inline-block; padding: 14px 32px; background-color: #3b82f6; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center; box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);">Verify Email Address</a>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 20px 0; color: #6b7280; font-size: 14px; line-height: 1.6;">Or copy and paste this link into your browser:</p>
              <p style="margin: 0 0 30px; padding: 12px; background-color: #f9fafb; border-radius: 4px; word-break: break-all; color: #4a4a4a; font-size: 13px; font-family: 'Courier New', monospace; line-height: 1.5;">${escapedDisplayUrl}</p>
              
              <!-- Warning -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 30px 0; background-color: #dbeafe; border-left: 4px solid #3b82f6; border-radius: 4px;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0; color: #1e40af; font-size: 14px; line-height: 1.6; font-weight: 500;">ℹ️ This link will expire in 24 hours for security reasons.</p>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 30px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">If you did not request this email change, please ignore this email. Your email address will remain unchanged.</p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6; text-align: center;">This is an automated message from SlugBase. Please do not reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

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

    // Escape user-provided email to prevent XSS
    const escapedTestEmail = escapeHtml(testEmail);
    
    const subject = 'SMTP Test Email - SlugBase';
    const sentDate = new Date().toLocaleString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });
    
    const html = `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>SMTP Test Email</title>
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
            <td style="padding: 40px 40px 30px; text-align: center; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">SlugBase</h1>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 0 0 30px; background-color: #d1fae5; border-left: 4px solid #10b981; border-radius: 4px;">
                <tr>
                  <td style="padding: 20px; text-align: center;">
                    <p style="margin: 0; color: #065f46; font-size: 48px; line-height: 1;">✓</p>
                  </td>
                </tr>
              </table>
              
              <h2 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px; font-weight: 600; line-height: 1.3; text-align: center;">SMTP Configuration Test</h2>
              <p style="margin: 0 0 30px; color: #4a4a4a; font-size: 16px; line-height: 1.6; text-align: center;">If you received this email, your SMTP configuration is working correctly!</p>
              
              <!-- Info Box -->
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
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #f9fafb; border-top: 1px solid #e5e7eb; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6; text-align: center;">This is a test email from SlugBase. Your SMTP configuration is working correctly.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

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

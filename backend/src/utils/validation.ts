import dns from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';
import { promisify } from 'node:util';
import { URL } from 'url';

const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

/**
 * Input validation utilities
 */

// Maximum lengths for various fields
export const MAX_LENGTHS = {
  email: 255,
  name: 255,
  title: 500,
  url: 2048,
  slug: 255,
  description: 1000,
  tagName: 100,
  folderName: 255,
  teamName: 255,
  teamDescription: 500,
  icon: 50,
  /** Contact form message body (M1: cap to prevent DoS and log size) */
  contactMessage: 10000,
} as const;

/**
 * Validate email address
 */
export function validateEmail(email: string): { valid: boolean; error?: string } {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email is required' };
  }

  if (email.length > MAX_LENGTHS.email) {
    return { valid: false, error: `Email must be no more than ${MAX_LENGTHS.email} characters` };
  }

  // Normalize email (lowercase)
  const normalized = email.toLowerCase().trim();

  // Basic email regex (RFC 5322 simplified)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalized)) {
    return { valid: false, error: 'Invalid email format' };
  }

  return { valid: true };
}

/**
 * Normalize email (lowercase, trim)
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Validate URL
 */
export function validateUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }

  if (url.length > MAX_LENGTHS.url) {
    return { valid: false, error: `URL must be no more than ${MAX_LENGTHS.url} characters` };
  }

  // First, check for dangerous protocols before parsing (prevents bypass)
  const lowerUrl = url.toLowerCase().trim();
  if (lowerUrl.startsWith('javascript:') || lowerUrl.startsWith('data:') || lowerUrl.startsWith('vbscript:')) {
    return { valid: false, error: 'Invalid URL protocol' };
  }

  try {
    const parsed = new URL(url);
    
    // Normalize protocol to lowercase for comparison
    const protocol = parsed.protocol.toLowerCase();
    
    // Only allow http and https protocols
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { valid: false, error: 'URL must use http or https protocol' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Validate slug format
 */
export function validateSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || typeof slug !== 'string') {
    return { valid: false, error: 'Slug is required' };
  }

  if (slug.length > MAX_LENGTHS.slug) {
    return { valid: false, error: `Slug must be no more than ${MAX_LENGTHS.slug} characters` };
  }

  // Allow alphanumeric, hyphens, and underscores only
  const slugRegex = /^[a-zA-Z0-9_-]+$/;
  if (!slugRegex.test(slug)) {
    return { valid: false, error: 'Slug can only contain letters, numbers, hyphens, and underscores' };
  }

  return { valid: true };
}

/**
 * Validate string length
 */
export function validateLength(
  value: string,
  fieldName: string,
  minLength: number,
  maxLength: number
): { valid: boolean; error?: string } {
  if (typeof value !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }

  if (value.length < minLength) {
    return { valid: false, error: `${fieldName} must be at least ${minLength} characters` };
  }

  if (value.length > maxLength) {
    return { valid: false, error: `${fieldName} must be no more than ${maxLength} characters` };
  }

  return { valid: true };
}

/**
 * Validate password complexity
 */
export function validatePassword(password: string): { valid: boolean; error?: string } {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }

  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long' };
  }

  if (password.length > 128) {
    return { valid: false, error: 'Password must be no more than 128 characters' };
  }

  // Check for at least one uppercase letter
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' };
  }

  // Check for at least one lowercase letter
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one lowercase letter' };
  }

  // Check for at least one number
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number' };
  }

  // Check for at least one special character
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one special character' };
  }

  return { valid: true };
}

/**
 * Sanitize string (remove potentially dangerous characters)
 */
export function sanitizeString(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  // Remove null bytes and control characters
  return input.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/**
 * Check if an IPv4 address is in a private/internal range (SSRF prevention).
 */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Invalid, treat as blocked
  }
  // 127.0.0.0/8 (loopback)
  if (parts[0] === 127) return true;
  // 10.0.0.0/8 (RFC 1918)
  if (parts[0] === 10) return true;
  // 172.16.0.0/12 (RFC 1918)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16 (RFC 1918)
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16 (link-local, cloud metadata)
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0/8 (current network)
  if (parts[0] === 0) return true;
  // 224.0.0.0/4 (multicast; align with metadata fetch SSRF checks)
  if (parts[0] >= 224 && parts[0] <= 239) return true;
  return false;
}

/**
 * Check if an IPv6 address is in a private/internal range (SSRF prevention).
 */
function isPrivateIPv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('::ffff:127.')) return true; // IPv4-mapped loopback
  if (lower.startsWith('::ffff:10.')) return true; // IPv4-mapped private
  if (lower.startsWith('::ffff:192.168.')) return true;
  if (lower.startsWith('::ffff:172.')) return true;
  if (lower.startsWith('::ffff:169.254.')) return true;
  return false;
}

/**
 * Check if hostname is a known SSRF target (metadata, local, internal).
 */
function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost') return true;
  if (lower === 'metadata') return true;
  if (lower.endsWith('.metadata')) return true;
  if (lower.includes('metadata.google')) return true;
  if (lower.endsWith('.internal')) return true;
  if (lower.endsWith('.local')) return true;
  return false;
}

/**
 * Validate OIDC provider URL (prevents SSRF - internal/private endpoints).
 * Must be HTTPS; in production, rejects localhost and private IPs.
 */
export function validateOidcUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }
  const trimmed = url.trim();
  if (trimmed.length > MAX_LENGTHS.url) {
    return { valid: false, error: `URL must be no more than ${MAX_LENGTHS.url} characters` };
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return { valid: false, error: 'Invalid URL protocol' };
  }
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const host = parsed.hostname;

    // Must be http or https
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { valid: false, error: 'OIDC URL must use http or https protocol' };
    }

    // In production, require HTTPS (except explicit localhost for dev)
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && protocol !== 'https:') {
      return { valid: false, error: 'OIDC URL must use HTTPS in production' };
    }

    // Block private IPs and metadata endpoints
    if (host.includes('[')) {
      // IPv6
      const match = host.match(/^\[([^\]]+)\]/);
      const ip = match ? match[1] : host;
      if (isPrivateIPv6(ip)) {
        return { valid: false, error: 'OIDC URL cannot point to private or internal addresses' };
      }
    } else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
      // IPv4
      if (isPrivateIPv4(host)) {
        return { valid: false, error: 'OIDC URL cannot point to private or internal addresses' };
      }
    } else {
      // Hostname
      if (isBlockedHostname(host)) {
        return { valid: false, error: 'OIDC URL cannot point to internal or metadata endpoints' };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Resolve hostname (A/AAAA) and ensure no resolved address is private/internal (DNS rebind / SSRF).
 */
async function resolveOidcHostname(hostname: string): Promise<void> {
  try {
    const [ipv4, ipv6] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
    const ips: string[] = [];
    if (ipv4.status === 'fulfilled') ips.push(...ipv4.value);
    if (ipv6.status === 'fulfilled') ips.push(...ipv6.value);
    for (const ip of ips) {
      if (ip.includes('.')) {
        if (isPrivateIPv4(ip)) {
          throw new Error('OIDC URL cannot point to private or internal addresses');
        }
      } else if (isPrivateIPv6(ip)) {
        throw new Error('OIDC URL cannot point to private or internal addresses');
      }
    }
    if (ips.length === 0) {
      throw new Error('OIDC URL host could not be resolved');
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException & { message?: string };
    if (err?.message?.startsWith('OIDC URL')) throw err;
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      throw new Error('OIDC URL host could not be resolved');
    }
    throw err;
  }
}

/**
 * Async OIDC URL validation: same rules as {@link validateOidcUrl}, plus DNS resolution so
 * hostnames cannot bypass checks by resolving to private/metadata IPs (DNS rebinding).
 */
export async function validateOidcUrlAsync(
  url: string
): Promise<{ valid: boolean; error?: string }> {
  const sync = validateOidcUrl(url);
  if (!sync.valid) return sync;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  const host = parsed.hostname;
  if (isIPv4(host) || isIPv6(host)) {
    return { valid: true };
  }

  try {
    await resolveOidcHostname(host);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Invalid OIDC URL';
    return { valid: false, error: msg };
  }

  return { valid: true };
}

/**
 * Validate redirect URL is same-origin with allowed base (prevents open redirect).
 * Returns the resolved absolute URL if valid, null otherwise.
 */
export function validateRedirectUrl(url: string, allowedBase: string): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, allowedBase);
    const allowed = new URL(allowedBase);
    if (parsed.origin !== allowed.origin) return null;
    if (!parsed.pathname.startsWith('/')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Validate OIDC provider_key format (alphanumeric, hyphens, underscores; max 50 chars).
 */
export function validateProviderKey(key: string): { valid: boolean; error?: string } {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Provider key is required' };
  }
  const trimmed = key.trim();
  if (trimmed.length > 50) {
    return { valid: false, error: 'Provider key must be no more than 50 characters' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { valid: false, error: 'Provider key can only contain letters, numbers, hyphens, and underscores' };
  }
  return { valid: true };
}

/**
 * Validate column name against whitelist (prevents SQL injection in dynamic queries)
 * Use this if you ever need to build dynamic ORDER BY or SELECT clauses from user input
 * 
 * @param columnName - The column name to validate
 * @param allowedColumns - Array of allowed column names
 * @returns The validated column name if valid, null otherwise
 */
export function validateColumnName(columnName: string, allowedColumns: string[]): string | null {
  if (typeof columnName !== 'string' || !columnName) {
    return null;
  }
  
  // Only allow alphanumeric, underscores, and dots (for table.column notation)
  if (!/^[a-zA-Z0-9_.]+$/.test(columnName)) {
    return null;
  }
  
  // Check against whitelist
  if (allowedColumns.includes(columnName)) {
    return columnName;
  }
  
  return null;
}

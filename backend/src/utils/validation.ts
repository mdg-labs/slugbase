import { URL } from 'url';

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

/**
 * Environment variable validation
 * Ensures all required security-related environment variables are set
 */

export function validateEnvironmentVariables(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Critical security variables - must be set
  if (!process.env.JWT_SECRET) {
    errors.push('JWT_SECRET is required but not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  } else if (process.env.JWT_SECRET === 'slugbase-jwt-secret-change-in-production' || process.env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters and not use the default value');
  }

  if (!process.env.ENCRYPTION_KEY) {
    errors.push('ENCRYPTION_KEY is required but not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  } else if (process.env.ENCRYPTION_KEY.length < 32) {
    errors.push('ENCRYPTION_KEY must be at least 32 characters');
  }

  // Session secret: required in production (M3/L4) so we don't fall back to JWT_SECRET or default
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
      errors.push('SESSION_SECRET is required in production and must be at least 32 characters');
    }
  } else if (!process.env.SESSION_SECRET) {
    warnings.push('SESSION_SECRET is not set (may be used as fallback)');
  }

  // DEMO_MODE validation (optional, but check if enabled)
  if (process.env.DEMO_MODE === 'true') {
    warnings.push('DEMO_MODE is enabled - this is intended for demonstration purposes only');
    // Note: ENCRYPTION_KEY is still required even in demo mode for OIDC secret encryption
    // JWT_SECRET validation is already handled above with the default check
  }

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.FRONTEND_URL) {
      warnings.push('FRONTEND_URL should be set in production');
    }
    if (!process.env.BASE_URL) {
      warnings.push('BASE_URL should be set in production');
    }
  }

  // Display warnings
  if (warnings.length > 0) {
    console.warn('Environment variable warnings:');
    warnings.forEach(warning => console.warn(`  - ${warning}`));
  }

  // Fail on errors
  if (errors.length > 0) {
    console.error('Environment variable validation failed:');
    errors.forEach(error => console.error(`  ❌ ${error}`));
    console.error('\nPlease set the required environment variables before starting the server.');
    process.exit(1);
  }
}

import passport from 'passport';
import { Strategy as OpenIDConnectStrategy, Profile } from 'passport-openidconnect';
import { queryOne, execute, query } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { decryptSensitiveAtRest } from '../utils/encryption.js';
import { generateUserKey } from '../utils/user-key.js';
import type { OIDCProviderRecord, OidcConfigProvider } from '../types/oidc-provider.js';
import { getDefaultTenantId } from '../utils/tenant.js';

export function setupOIDC() {
  // Serialization for OIDC OAuth flow (sessions are only used during OAuth redirect)
  // After OAuth completes, we convert to JWT and destroy the session
  passport.serializeUser((user: any, done) => {
    // Store minimal user info in session (only needed during OAuth flow)
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });
}

/** Register a single OIDC strategy from DB-backed configuration. */
async function registerOIDCStrategy(provider: OIDCProviderRecord, clientSecret: string): Promise<void> {
  if (!provider.client_id || !clientSecret || !provider.issuer_url || !provider.provider_key) {
    throw new Error(`Missing required fields for provider ${provider.provider_key || provider.id}`);
  }

  const verifyFunction = async (iss: string, profile: Profile, context: any, idToken: string, accessToken: string, refreshToken: string, params: any, cb: (error: any, user?: any) => void) => {
            // Extract sub from profile (profile.id is the sub claim) - do this before try block so it's available in catch
            const sub = profile.id || (profile as any).sub;
            if (!sub) {
              console.error(`[OIDC] No sub found in profile for provider: ${provider.provider_key}`);
              return cb(new Error('Sub claim is required for OIDC authentication'), null);
            }
            
            try {
              const email = profile.emails?.[0]?.value || (profile as any).email;
              if (!email) {
                console.error(`[OIDC] No email found in profile for provider: ${provider.provider_key}`);
                return cb(new Error('Email is required for OIDC authentication'), null);
              }

              // Use email as primary identifier - check if user exists by email
              let user = await queryOne(
                'SELECT * FROM users WHERE email = ?',
                [email]
              );

              if (user) {
                // User exists - update OIDC info if not set
                if (!user.oidc_sub || !user.oidc_provider) {
                  await execute(
                    'UPDATE users SET oidc_sub = ?, oidc_provider = ? WHERE id = ?',
                    [sub, provider.provider_key, user.id]
                  );
                  user = await queryOne('SELECT * FROM users WHERE id = ?', [user.id]);
                }
                // If user exists with different OIDC provider, that's fine - email is the identifier
                return cb(null, user);
              }

              // User doesn't exist - check if auto-creation is enabled
              // Handle both SQLite (0/1) and PostgreSQL (true/false) boolean values
              // Also handle string representations from database queries
              const autoCreateValue = provider.auto_create_users;
              const autoCreate = autoCreateValue === true || 
                                 autoCreateValue === 1 || 
                                 autoCreateValue === '1' ||
                                 (autoCreateValue !== false && 
                                  autoCreateValue !== 0 && 
                                  autoCreateValue !== '0' &&
                                  autoCreateValue !== null &&
                                  autoCreateValue !== undefined);
              if (!autoCreate) {
                console.error('OIDC auto-creation disabled. Provider:', provider.provider_key, 'auto_create_users:', autoCreateValue);
                return cb(new Error('AUTO_CREATE_DISABLED'), null);
              }

              // Create new user
              const userId = uuidv4();
              let userKey = await generateUserKey();
              const name = profile.displayName || profile.name || email;

              // Determine user role
              let isAdmin = false;
              const defaultRole = provider.default_role || 'user';
              
              if (defaultRole === 'admin') {
                isAdmin = true;
              } else {
                // Check if this is the first user (auto-admin for first user, regardless of default_role)
                const userCount = await queryOne('SELECT COUNT(*) as count FROM users', []);
                isAdmin = !userCount || parseInt((userCount as any).count) === 0;
              }

              // Retry logic for user_key collisions (should be extremely rare)
              let retries = 0;
              const maxRetries = 3;
              while (retries < maxRetries) {
                try {
                  await execute(
                    `INSERT INTO users (id, email, name, user_key, is_admin, oidc_sub, oidc_provider) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [userId, email, name, userKey, isAdmin, sub, provider.provider_key]
                  );
                  break; // Success, exit retry loop
                } catch (error: any) {
                  // If user_key collision, generate new key and retry
                  if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate')) 
                      && error.message.includes('user_key')) {
                    retries++;
                    if (retries >= maxRetries) {
                      return cb(new Error('Failed to create user. Please try again.'), null);
                    }
                    userKey = await generateUserKey();
                    continue; // Retry with new key
                  }
                  // For other errors (like email duplicate), throw to outer catch
                  throw error;
                }
              }

              user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
              return cb(null, user);
            } catch (error: any) {
              console.error(`[OIDC] Error during user creation/update:`, {
                message: error.message,
                stack: error.stack,
                name: error.name,
              });
              
              // Handle unique constraint violation (email already exists)
              if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate'))) {
                // Try to get the existing user by email
                const existingUser = await queryOne('SELECT * FROM users WHERE email = ?', [profile.emails?.[0]?.value || (profile as any).email]);
                if (existingUser) {
                  // Update OIDC info for existing user
                  await execute(
                    'UPDATE users SET oidc_sub = ?, oidc_provider = ? WHERE id = ?',
                    [sub, provider.provider_key, existingUser.id]
                  );
                  const updatedUser = await queryOne('SELECT * FROM users WHERE id = ?', [existingUser.id]);
                  return cb(null, updatedUser);
                }
              }
              console.error(`[OIDC] Fatal error, cannot proceed:`, error);
              return cb(error, null);
            }
  };

  const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
  const callbackURL = `${baseUrl}/api/auth/${provider.provider_key}/callback`;
  const authorizationURL = provider.authorization_url || `${provider.issuer_url}/authorize`;
  const tokenURL = provider.token_url || `${provider.issuer_url}/token`;
  const userInfoURL = provider.userinfo_url || `${provider.issuer_url}/userinfo`;
  const strategyConfig: any = {
    issuer: provider.issuer_url,
    authorizationURL,
    tokenURL,
    userInfoURL,
    clientID: provider.client_id,
    clientSecret,
    callbackURL,
    scope: (typeof provider.scopes === 'string' ? provider.scopes : '').split(' ').filter(Boolean),
    skipUserProfile: false,
  };
  passport.use(provider.provider_key, new OpenIDConnectStrategy(strategyConfig, verifyFunction as any));
}

class DatabaseOidcConfigProvider implements OidcConfigProvider {
  async getProviders(tenantId: string): Promise<OIDCProviderRecord[]> {
    const providers = await query(
      'SELECT id, provider_key, client_id, client_secret, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role FROM oidc_providers WHERE tenant_id = ?',
      [tenantId]
    );
    return Array.isArray(providers) ? (providers as OIDCProviderRecord[]) : (providers ? [providers as OIDCProviderRecord] : []);
  }
}

const oidcProviderStore: OidcConfigProvider = new DatabaseOidcConfigProvider();

export async function loadOIDCStrategies(tenantId: string = getDefaultTenantId()) {
  try {
    const providersList = await oidcProviderStore.getProviders(tenantId);
    if (providersList.length === 0) return;
    for (const provider of providersList) {
      try {
        const decryptedSecret = decryptSensitiveAtRest(provider.client_secret);
        await registerOIDCStrategy(provider, decryptedSecret);
      } catch (providerError: any) {
        console.error(`Error loading OIDC provider ${provider.provider_key || provider.id}:`, providerError.message || providerError);
      }
    }
  } catch (error: any) {
    console.error('Error loading OIDC strategies:', error.message || error);
  }
}


export async function reloadOIDCStrategies() {
  try {
    // Remove existing strategies (except 'jwt' which is our JWT strategy)
    // Use a type assertion to access internal strategies map
    const strategies = Object.keys((passport as any)._strategies || {});
    strategies.forEach((key: string) => {
      if (key !== 'jwt' && key !== 'session') {
        try {
          passport.unuse(key);
        } catch (error: any) {
          // Ignore errors when removing strategies
          console.warn(`Could not remove OIDC strategy ${key}:`, error.message || error);
        }
      }
    });
    
    // Reload from database
    await loadOIDCStrategies();
  } catch (error: any) {
    console.error('Error reloading OIDC strategies:', error.message || error);
    // Don't throw - allow the operation to continue even if strategy reload fails
  }
}

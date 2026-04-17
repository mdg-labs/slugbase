/**
 * Cloud-only OIDC providers driven by OIDC_* environment variables (Phase / Fly secrets).
 * Self-hosted continues to use the oidc_providers table + Admin UI.
 */
import type { OIDCProviderRecord } from '../types/oidc-provider.js';

function trimEnv(key: string): string {
  return (process.env[key] ?? '').trim();
}

/**
 * Returns synthetic provider rows when SLUGBASE_MODE=cloud and IdP credentials are set.
 * Env-defined providers override DB rows with the same provider_key at load time.
 */
export function getCloudOidcProviderRecordsFromEnv(): OIDCProviderRecord[] {
  if (process.env.SLUGBASE_MODE !== 'cloud') {
    return [];
  }

  const out: OIDCProviderRecord[] = [];

  const gId = trimEnv('OIDC_GOOGLE_CLIENT_ID');
  const gSecret = trimEnv('OIDC_GOOGLE_CLIENT_SECRET');
  if (gId && gSecret) {
    const provider_key = trimEnv('OIDC_GOOGLE_PROVIDER_KEY') || 'google';
    const issuer_url = trimEnv('OIDC_GOOGLE_ISSUER') || 'https://accounts.google.com';
    const scopes = trimEnv('OIDC_GOOGLE_SCOPES') || 'openid profile email';
    out.push({
      id: `env:${provider_key}`,
      provider_key,
      client_id: gId,
      client_secret: gSecret,
      issuer_url,
      authorization_url: null,
      token_url: null,
      userinfo_url: null,
      scopes,
      auto_create_users: true,
      default_role: 'user',
    });
  }

  const mId = trimEnv('OIDC_MICROSOFT_CLIENT_ID');
  const mSecret = trimEnv('OIDC_MICROSOFT_CLIENT_SECRET');
  if (mId && mSecret) {
    const provider_key = trimEnv('OIDC_MICROSOFT_PROVIDER_KEY') || 'microsoft';
    const tenant = trimEnv('OIDC_MICROSOFT_TENANT') || 'common';
    const issuer_url =
      trimEnv('OIDC_MICROSOFT_ISSUER') || `https://login.microsoftonline.com/${tenant}/v2.0`;
    const scopes = trimEnv('OIDC_MICROSOFT_SCOPES') || 'openid profile email';
    out.push({
      id: `env:${provider_key}`,
      provider_key,
      client_id: mId,
      client_secret: mSecret,
      issuer_url,
      authorization_url: null,
      token_url: null,
      userinfo_url: null,
      scopes,
      auto_create_users: true,
      default_role: 'user',
    });
  }

  return out;
}

export function getCloudOidcProviderByKey(providerKey: string): OIDCProviderRecord | undefined {
  return getCloudOidcProviderRecordsFromEnv().find((p) => p.provider_key === providerKey);
}

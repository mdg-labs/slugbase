/**
 * CLOUD mode: fixed OIDC providers from environment (Google, Microsoft, GitHub).
 * Only include providers where both client_id and client_secret are set.
 */

export interface CloudProviderConfig {
  provider_key: string;
  client_id: string;
  client_secret: string;
  issuer_url: string;
  authorization_url?: string;
  token_url?: string;
  userinfo_url?: string;
  scopes: string;
  auto_create_users: boolean;
  default_role: string;
}

const GOOGLE_ISSUER = 'https://accounts.google.com';
const MICROSOFT_TENANT = process.env.OIDC_MICROSOFT_TENANT || 'common';
const MICROSOFT_ISSUER = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/v2.0`;
const GITHUB_AUTH = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';

export function getCloudProviders(): CloudProviderConfig[] {
  const providers: CloudProviderConfig[] = [];

  const googleId = process.env.OIDC_GOOGLE_CLIENT_ID?.trim();
  const googleSecret = process.env.OIDC_GOOGLE_CLIENT_SECRET?.trim();
  if (googleId && googleSecret) {
    providers.push({
      provider_key: 'google',
      client_id: googleId,
      client_secret: googleSecret,
      issuer_url: GOOGLE_ISSUER,
      scopes: 'openid profile email',
      auto_create_users: true,
      default_role: 'user',
    });
  }

  const msId = process.env.OIDC_MICROSOFT_CLIENT_ID?.trim();
  const msSecret = process.env.OIDC_MICROSOFT_CLIENT_SECRET?.trim();
  if (msId && msSecret) {
    providers.push({
      provider_key: 'microsoft',
      client_id: msId,
      client_secret: msSecret,
      issuer_url: MICROSOFT_ISSUER,
      authorization_url: `${MICROSOFT_ISSUER}/authorize`,
      token_url: `${MICROSOFT_ISSUER}/token`,
      userinfo_url: 'https://graph.microsoft.com/oidc/userinfo',
      scopes: 'openid profile email',
      auto_create_users: true,
      default_role: 'user',
    });
  }

  const ghId = process.env.OIDC_GITHUB_CLIENT_ID?.trim();
  const ghSecret = process.env.OIDC_GITHUB_CLIENT_SECRET?.trim();
  if (ghId && ghSecret) {
    providers.push({
      provider_key: 'github',
      client_id: ghId,
      client_secret: ghSecret,
      issuer_url: 'https://github.com',
      authorization_url: GITHUB_AUTH,
      token_url: GITHUB_TOKEN,
      userinfo_url: GITHUB_USER,
      scopes: 'openid user:email',
      auto_create_users: true,
      default_role: 'user',
    });
  }

  return providers;
}

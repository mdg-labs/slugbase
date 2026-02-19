export interface OIDCProviderRecord {
  id: string;
  provider_key: string;
  client_id: string;
  client_secret: string;
  issuer_url: string;
  authorization_url?: string | null;
  token_url?: string | null;
  userinfo_url?: string | null;
  scopes: string;
  auto_create_users: boolean | number | string | null;
  default_role?: string | null;
}

export interface OidcConfigProvider {
  getProviders(tenantId: string): Promise<OIDCProviderRecord[]>;
}

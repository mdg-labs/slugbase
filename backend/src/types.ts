export interface User {
  id: string;
  email: string;
  name: string;
  user_key: string;
  is_admin: boolean;
  oidc_sub?: string;
  oidc_provider?: string;
  language: string;
  theme: string;
  created_at: string;
}

export interface OIDCProvider {
  id: string;
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
  created_at: string;
}

export interface Folder {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export interface Bookmark {
  id: string;
  user_id: string;
  title: string;
  url: string;
  slug: string;
  forwarding_enabled: boolean;
  pinned?: boolean;
  access_count?: number;
  last_accessed_at?: string | null;
  folder_id?: string;
  folder?: Folder;
  tags?: Tag[];
  created_at: string;
  updated_at: string;
}

/** Sent by frontend when user saved a bookmark after seeing AI suggestions; used for usage stats. */
export interface AiSuggestionUsed {
  title?: boolean;
  slug?: boolean;
  tags?: boolean;
}

export interface CreateBookmarkInput {
  title: string;
  url: string;
  slug?: string;
  forwarding_enabled: boolean;
  folder_ids?: string[];
  tag_ids?: string[];
  team_ids?: string[];
  user_ids?: string[];
  share_all_teams?: boolean;
  ai_suggestion_used?: AiSuggestionUsed;
}

export interface UpdateBookmarkInput {
  title?: string;
  url?: string;
  slug?: string;
  forwarding_enabled?: boolean;
  pinned?: boolean;
  folder_ids?: string[];
  tag_ids?: string[];
  team_ids?: string[];
  user_ids?: string[];
  share_all_teams?: boolean;
  ai_suggestion_used?: AiSuggestionUsed;
}

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(255) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  user_key VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  is_admin BOOLEAN DEFAULT FALSE,
  oidc_sub VARCHAR(255),
  oidc_provider VARCHAR(255),
  language VARCHAR(10) DEFAULT 'en',
  theme VARCHAR(10) DEFAULT 'auto',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  mfa_enabled BOOLEAN DEFAULT FALSE,
  mfa_totp_secret_enc TEXT,
  mfa_enrolled_at TIMESTAMP
);

-- OIDC providers table
CREATE TABLE IF NOT EXISTS oidc_providers (
  id VARCHAR(255) PRIMARY KEY,
  provider_key VARCHAR(255) UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  issuer_url TEXT NOT NULL,
  scopes TEXT NOT NULL,
  auto_create_users BOOLEAN DEFAULT TRUE,
  default_role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Folders table
CREATE TABLE IF NOT EXISTS folders (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  icon VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, name)
);

-- Tags table
CREATE TABLE IF NOT EXISTS tags (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, name)
);

-- Bookmarks table
CREATE TABLE IF NOT EXISTS bookmarks (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  slug VARCHAR(255),
  forwarding_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(slug)
);

-- Bookmark folders junction table (many-to-many)
CREATE TABLE IF NOT EXISTS bookmark_folders (
  bookmark_id VARCHAR(255) NOT NULL,
  folder_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (bookmark_id, folder_id),
  FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

-- Bookmark tags junction table
CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id VARCHAR(255) NOT NULL,
  tag_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (bookmark_id, tag_id),
  FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- Teams table
CREATE TABLE IF NOT EXISTS teams (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Team memberships junction table
CREATE TABLE IF NOT EXISTS team_members (
  user_id VARCHAR(255) NOT NULL,
  team_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (user_id, team_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

-- Bookmark team shares junction table
CREATE TABLE IF NOT EXISTS bookmark_team_shares (
  bookmark_id VARCHAR(255) NOT NULL,
  team_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (bookmark_id, team_id),
  FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

-- Folder team shares junction table
CREATE TABLE IF NOT EXISTS folder_team_shares (
  folder_id VARCHAR(255) NOT NULL,
  team_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (folder_id, team_id),
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

-- Bookmark user shares junction table
CREATE TABLE IF NOT EXISTS bookmark_user_shares (
  bookmark_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (bookmark_id, user_id),
  FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Folder user shares junction table
CREATE TABLE IF NOT EXISTS folder_user_shares (
  folder_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  PRIMARY KEY (folder_id, user_id),
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- System initialization flag
CREATE TABLE IF NOT EXISTS system_config (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL
);

-- MFA backup codes (hashes only — TOTP secret lives encrypted on users.mfa_totp_secret_enc)
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user_id ON mfa_backup_codes(user_id);

-- Password reset tokens table
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for password reset tokens
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id ON bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_slug ON bookmarks(slug);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_slug ON bookmarks(user_id, slug);
CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id);
CREATE INDEX IF NOT EXISTS idx_users_user_key ON users(user_key);
CREATE INDEX IF NOT EXISTS idx_users_oidc ON users(oidc_sub, oidc_provider);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_bookmark_team_shares_bookmark ON bookmark_team_shares(bookmark_id);
CREATE INDEX IF NOT EXISTS idx_bookmark_team_shares_team ON bookmark_team_shares(team_id);
CREATE INDEX IF NOT EXISTS idx_folder_team_shares_folder ON folder_team_shares(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_team_shares_team ON folder_team_shares(team_id);
CREATE INDEX IF NOT EXISTS idx_bookmark_folders_bookmark ON bookmark_folders(bookmark_id);
CREATE INDEX IF NOT EXISTS idx_bookmark_folders_folder ON bookmark_folders(folder_id);
CREATE INDEX IF NOT EXISTS idx_bookmark_user_shares_bookmark ON bookmark_user_shares(bookmark_id);
CREATE INDEX IF NOT EXISTS idx_bookmark_user_shares_user ON bookmark_user_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_folder_user_shares_folder ON folder_user_shares(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_user_shares_user ON folder_user_shares(user_id);

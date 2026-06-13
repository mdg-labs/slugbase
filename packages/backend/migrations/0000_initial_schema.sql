CREATE TABLE "analytics_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"client_id" text NOT NULL,
	"granted" boolean NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_suggestion_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"output_language" text NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"tags" text NOT NULL,
	"detected_language" text NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"last_used_at" bigint,
	"created_at" bigint NOT NULL,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookmark_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"bookmark_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookmark_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"bookmark_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookmark_team_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"bookmark_id" text NOT NULL,
	"team_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookmark_user_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"bookmark_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"slug" text,
	"forwarding_enabled" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"plan_archived" boolean DEFAULT false NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_team_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"team_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_user_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_backup_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"issuer_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"scopes" text DEFAULT 'openid email profile' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"last_activity_at" bigint NOT NULL,
	"data" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slug_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"bookmark_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_metadata" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"theme" text DEFAULT 'auto' NOT NULL,
	"accent_color" text,
	"is_instance_admin" boolean DEFAULT false NOT NULL,
	"mfa_state" text DEFAULT 'not_enrolled' NOT NULL,
	"mfa_totp_secret_encrypted" text,
	"ai_opt_out" boolean DEFAULT false NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"invited_email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"accepted_at" bigint,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"plan_seats" integer,
	"plan_archived" boolean DEFAULT false NOT NULL,
	"billing_customer_id" text,
	"billing_subscription_id" text,
	"billing_status" text,
	"billing_period_end" bigint,
	"permanent_personal" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_consents" ADD CONSTRAINT "analytics_consents_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_consents_user_id_unique_idx" ON "analytics_consents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_consents_client_id_unique_idx" ON "analytics_consents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "analytics_consents_granted_idx" ON "analytics_consents" USING btree ("granted");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_suggestion_cache_key_unique_idx" ON "ai_suggestion_cache" USING btree ("workspace_id","user_id","canonical_url","output_language");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_user_id_name_unique_idx" ON "api_tokens" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "api_tokens_token_prefix_idx" ON "api_tokens" USING btree ("token_prefix");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_created_idx" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_actor_idx" ON "audit_events" USING btree ("workspace_id","actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_entity_type_idx" ON "audit_events" USING btree ("workspace_id","entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "bookmark_folders_workspace_folder_bookmark_unique_idx" ON "bookmark_folders" USING btree ("workspace_id","folder_id","bookmark_id");--> statement-breakpoint
CREATE INDEX "bookmark_folders_folder_id_idx" ON "bookmark_folders" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "bookmark_folders_bookmark_id_idx" ON "bookmark_folders" USING btree ("bookmark_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookmark_tags_workspace_tag_bookmark_unique_idx" ON "bookmark_tags" USING btree ("workspace_id","tag_id","bookmark_id");--> statement-breakpoint
CREATE INDEX "bookmark_tags_tag_id_idx" ON "bookmark_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "bookmark_tags_bookmark_id_idx" ON "bookmark_tags" USING btree ("bookmark_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookmark_team_shares_workspace_bookmark_team_unique_idx" ON "bookmark_team_shares" USING btree ("workspace_id","bookmark_id","team_id");--> statement-breakpoint
CREATE INDEX "bookmark_team_shares_bookmark_id_idx" ON "bookmark_team_shares" USING btree ("bookmark_id");--> statement-breakpoint
CREATE INDEX "bookmark_team_shares_team_id_idx" ON "bookmark_team_shares" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookmark_user_shares_workspace_bookmark_user_unique_idx" ON "bookmark_user_shares" USING btree ("workspace_id","bookmark_id","user_id");--> statement-breakpoint
CREATE INDEX "bookmark_user_shares_bookmark_id_idx" ON "bookmark_user_shares" USING btree ("bookmark_id");--> statement-breakpoint
CREATE INDEX "bookmark_user_shares_user_id_idx" ON "bookmark_user_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bookmarks_workspace_id_idx" ON "bookmarks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "bookmarks_user_id_idx" ON "bookmarks" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_workspace_slug_unique_idx" ON "bookmarks" USING btree ("workspace_id","slug") WHERE "bookmarks"."slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_verification_tokens_token_hash_idx" ON "email_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "folder_team_shares_workspace_folder_team_unique_idx" ON "folder_team_shares" USING btree ("workspace_id","folder_id","team_id");--> statement-breakpoint
CREATE INDEX "folder_team_shares_folder_id_idx" ON "folder_team_shares" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "folder_team_shares_team_id_idx" ON "folder_team_shares" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folder_user_shares_workspace_folder_user_unique_idx" ON "folder_user_shares" USING btree ("workspace_id","folder_id","user_id");--> statement-breakpoint
CREATE INDEX "folder_user_shares_folder_id_idx" ON "folder_user_shares" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "folder_user_shares_user_id_idx" ON "folder_user_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "folders_workspace_id_idx" ON "folders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "folders_user_id_idx" ON "folders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "folders_workspace_user_id_idx" ON "folders" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "mfa_backup_codes_user_id_idx" ON "mfa_backup_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_accounts_provider_subject_unique_idx" ON "oidc_accounts" USING btree ("provider_id","subject");--> statement-breakpoint
CREATE INDEX "oidc_accounts_user_id_idx" ON "oidc_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oidc_providers_enabled_idx" ON "oidc_providers" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_providers_issuer_url_client_id_unique_idx" ON "oidc_providers" USING btree ("issuer_url","client_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_token_hash_idx" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slug_preferences_workspace_user_slug_unique_idx" ON "slug_preferences" USING btree ("workspace_id","user_id","slug");--> statement-breakpoint
CREATE INDEX "slug_preferences_bookmark_id_idx" ON "slug_preferences" USING btree ("bookmark_id");--> statement-breakpoint
CREATE INDEX "tags_workspace_id_idx" ON "tags" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "tags_user_id_idx" ON "tags" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tags_workspace_user_id_idx" ON "tags" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_memberships_workspace_team_user_unique_idx" ON "team_memberships" USING btree ("workspace_id","team_id","user_id");--> statement-breakpoint
CREATE INDEX "team_memberships_team_id_idx" ON "team_memberships" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_memberships_user_id_idx" ON "team_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "teams_workspace_id_idx" ON "teams" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "teams_workspace_name_idx" ON "teams" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "user_accounts_email_unique_idx" ON "user_accounts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "user_accounts_is_instance_admin_idx" ON "user_accounts" USING btree ("is_instance_admin");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_token_hash_unique_idx" ON "workspace_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_pending_email_unique_idx" ON "workspace_invitations" USING btree ("workspace_id","invited_email") WHERE "workspace_invitations"."accepted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_id_idx" ON "workspace_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_invitations_invited_email_idx" ON "workspace_invitations" USING btree ("invited_email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user_unique_idx" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_workspace_id_idx" ON "workspace_members" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_unique_idx" ON "workspaces" USING btree ("slug");
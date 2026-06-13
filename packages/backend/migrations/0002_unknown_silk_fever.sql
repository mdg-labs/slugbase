CREATE TABLE "email_change_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pending_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_accounts" ADD COLUMN "default_bookmark_view" text DEFAULT 'grid' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_accounts" ADD COLUMN "pending_email" text;--> statement-breakpoint
CREATE INDEX "email_change_tokens_user_id_idx" ON "email_change_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_change_tokens_token_hash_idx" ON "email_change_tokens" USING btree ("token_hash");
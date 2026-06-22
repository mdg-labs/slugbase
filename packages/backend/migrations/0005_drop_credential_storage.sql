DELETE FROM "instance_metadata" WHERE "key" IN ('smtp_settings', 'ai_settings');--> statement-breakpoint
DROP TABLE "oidc_providers" CASCADE;
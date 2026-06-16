ALTER TABLE "user_accounts" ADD COLUMN "onboarding_completed_at" bigint;--> statement-breakpoint
ALTER TABLE "user_accounts" ADD COLUMN "dashboard_checklist_dismissed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_accounts" ADD COLUMN "dashboard_checklist_manual" text;
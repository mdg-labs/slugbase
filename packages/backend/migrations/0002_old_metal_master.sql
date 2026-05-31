CREATE TABLE `user_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`theme` text DEFAULT 'auto' NOT NULL,
	`is_instance_admin` integer DEFAULT false NOT NULL,
	`mfa_state` text DEFAULT 'not_enrolled' NOT NULL,
	`ai_opt_out` integer DEFAULT false NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_accounts_email_unique_idx` ON `user_accounts` (`email`);--> statement-breakpoint
CREATE INDEX `user_accounts_is_instance_admin_idx` ON `user_accounts` (`is_instance_admin`);
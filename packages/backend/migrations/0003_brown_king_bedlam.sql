CREATE TABLE `mfa_backup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mfa_backup_codes_user_id_idx` ON `mfa_backup_codes` (`user_id`);--> statement-breakpoint
ALTER TABLE `user_accounts` ADD `mfa_totp_secret_encrypted` text;
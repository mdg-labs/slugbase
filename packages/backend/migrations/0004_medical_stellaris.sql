CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_user_id_name_unique_idx` ON `api_tokens` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `api_tokens_token_prefix_idx` ON `api_tokens` (`token_prefix`);
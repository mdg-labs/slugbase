CREATE TABLE `ai_suggestion_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`canonical_url` text NOT NULL,
	`output_language` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`tags` text NOT NULL,
	`detected_language` text NOT NULL,
	`confidence` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_suggestion_cache_key_unique_idx` ON `ai_suggestion_cache` (`workspace_id`,`user_id`,`canonical_url`,`output_language`);
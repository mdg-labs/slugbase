CREATE TABLE `bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`slug` text,
	`forwarding_enabled` integer DEFAULT false NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`plan_archived` integer DEFAULT false NOT NULL,
	`access_count` integer DEFAULT 0 NOT NULL,
	`last_accessed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookmarks_workspace_id_idx` ON `bookmarks` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `bookmarks_user_id_idx` ON `bookmarks` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bookmarks_workspace_slug_unique_idx` ON `bookmarks` (`workspace_id`,`slug`) WHERE "bookmarks"."slug" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `slug_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`bookmark_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slug_preferences_workspace_user_slug_unique_idx` ON `slug_preferences` (`workspace_id`,`user_id`,`slug`);--> statement-breakpoint
CREATE INDEX `slug_preferences_bookmark_id_idx` ON `slug_preferences` (`bookmark_id`);
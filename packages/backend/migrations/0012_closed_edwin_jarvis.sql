CREATE TABLE `bookmark_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`bookmark_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmark_tags_workspace_tag_bookmark_unique_idx` ON `bookmark_tags` (`workspace_id`,`tag_id`,`bookmark_id`);--> statement-breakpoint
CREATE INDEX `bookmark_tags_tag_id_idx` ON `bookmark_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX `bookmark_tags_bookmark_id_idx` ON `bookmark_tags` (`bookmark_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tags_workspace_id_idx` ON `tags` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `tags_user_id_idx` ON `tags` (`user_id`);--> statement-breakpoint
CREATE INDEX `tags_workspace_user_id_idx` ON `tags` (`workspace_id`,`user_id`);
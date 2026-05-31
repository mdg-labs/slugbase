CREATE TABLE `bookmark_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`bookmark_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmark_folders_workspace_folder_bookmark_unique_idx` ON `bookmark_folders` (`workspace_id`,`folder_id`,`bookmark_id`);--> statement-breakpoint
CREATE INDEX `bookmark_folders_folder_id_idx` ON `bookmark_folders` (`folder_id`);--> statement-breakpoint
CREATE INDEX `bookmark_folders_bookmark_id_idx` ON `bookmark_folders` (`bookmark_id`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `folders_workspace_id_idx` ON `folders` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `folders_user_id_idx` ON `folders` (`user_id`);--> statement-breakpoint
CREATE INDEX `folders_workspace_user_id_idx` ON `folders` (`workspace_id`,`user_id`);
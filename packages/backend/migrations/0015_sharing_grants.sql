CREATE TABLE `bookmark_team_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`bookmark_id` text NOT NULL,
	`team_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmark_team_shares_workspace_bookmark_team_unique_idx` ON `bookmark_team_shares` (`workspace_id`,`bookmark_id`,`team_id`);--> statement-breakpoint
CREATE INDEX `bookmark_team_shares_bookmark_id_idx` ON `bookmark_team_shares` (`bookmark_id`);--> statement-breakpoint
CREATE INDEX `bookmark_team_shares_team_id_idx` ON `bookmark_team_shares` (`team_id`);--> statement-breakpoint
CREATE TABLE `bookmark_user_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`bookmark_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmark_user_shares_workspace_bookmark_user_unique_idx` ON `bookmark_user_shares` (`workspace_id`,`bookmark_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `bookmark_user_shares_bookmark_id_idx` ON `bookmark_user_shares` (`bookmark_id`);--> statement-breakpoint
CREATE INDEX `bookmark_user_shares_user_id_idx` ON `bookmark_user_shares` (`user_id`);--> statement-breakpoint
CREATE TABLE `folder_team_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`team_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folder_team_shares_workspace_folder_team_unique_idx` ON `folder_team_shares` (`workspace_id`,`folder_id`,`team_id`);--> statement-breakpoint
CREATE INDEX `folder_team_shares_folder_id_idx` ON `folder_team_shares` (`folder_id`);--> statement-breakpoint
CREATE INDEX `folder_team_shares_team_id_idx` ON `folder_team_shares` (`team_id`);--> statement-breakpoint
CREATE TABLE `folder_user_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folder_user_shares_workspace_folder_user_unique_idx` ON `folder_user_shares` (`workspace_id`,`folder_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `folder_user_shares_folder_id_idx` ON `folder_user_shares` (`folder_id`);--> statement-breakpoint
CREATE INDEX `folder_user_shares_user_id_idx` ON `folder_user_shares` (`user_id`);
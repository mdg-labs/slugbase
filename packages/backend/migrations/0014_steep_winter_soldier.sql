CREATE TABLE `team_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_memberships_workspace_team_user_unique_idx` ON `team_memberships` (`workspace_id`,`team_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `team_memberships_team_id_idx` ON `team_memberships` (`team_id`);--> statement-breakpoint
CREATE INDEX `team_memberships_user_id_idx` ON `team_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `teams_workspace_id_idx` ON `teams` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `teams_workspace_name_idx` ON `teams` (`workspace_id`,`name`);
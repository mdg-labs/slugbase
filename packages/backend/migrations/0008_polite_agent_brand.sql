CREATE TABLE `workspace_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`invited_email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`accepted_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_token_hash_unique_idx` ON `workspace_invitations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_pending_email_unique_idx` ON `workspace_invitations` (`workspace_id`,`invited_email`) WHERE "workspace_invitations"."accepted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `workspace_invitations_workspace_id_idx` ON `workspace_invitations` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `workspace_invitations_invited_email_idx` ON `workspace_invitations` (`invited_email`);
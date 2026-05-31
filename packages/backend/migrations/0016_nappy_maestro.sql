CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_workspace_created_idx` ON `audit_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_workspace_actor_idx` ON `audit_events` (`workspace_id`,`actor_user_id`);--> statement-breakpoint
CREATE INDEX `audit_events_workspace_entity_type_idx` ON `audit_events` (`workspace_id`,`entity_type`);
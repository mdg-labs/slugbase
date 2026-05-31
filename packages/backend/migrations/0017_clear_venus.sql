CREATE TABLE `billing_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `billing_customer_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `billing_subscription_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `billing_status` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `billing_period_end` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `permanent_personal` integer DEFAULT false NOT NULL;
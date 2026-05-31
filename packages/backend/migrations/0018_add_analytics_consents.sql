CREATE TABLE `analytics_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`client_id` text NOT NULL,
	`granted` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_consents_user_id_unique_idx` ON `analytics_consents` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_consents_client_id_unique_idx` ON `analytics_consents` (`client_id`);--> statement-breakpoint
CREATE INDEX `analytics_consents_granted_idx` ON `analytics_consents` (`granted`);
CREATE TABLE `oidc_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_accounts_provider_subject_unique_idx` ON `oidc_accounts` (`provider_id`,`subject`);--> statement-breakpoint
CREATE INDEX `oidc_accounts_user_id_idx` ON `oidc_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `oidc_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`issuer_url` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_encrypted` text NOT NULL,
	`scopes` text DEFAULT 'openid email profile' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oidc_providers_enabled_idx` ON `oidc_providers` (`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_providers_issuer_url_client_id_unique_idx` ON `oidc_providers` (`issuer_url`,`client_id`);
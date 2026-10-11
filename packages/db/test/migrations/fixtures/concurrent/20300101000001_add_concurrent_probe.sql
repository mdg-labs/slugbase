CREATE TABLE concurrent_probe (id integer);
--> statement-breakpoint
SELECT pg_sleep(1);

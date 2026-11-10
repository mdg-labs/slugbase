ALTER TABLE perf_rows ALTER COLUMN n TYPE bigint;
--> statement-breakpoint
SELECT pg_sleep(1.5);

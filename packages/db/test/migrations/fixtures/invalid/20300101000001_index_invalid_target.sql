-- slugbase:non-transactional
CREATE UNIQUE INDEX CONCURRENTLY invalid_a_idx ON invalid_target (a);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "invalid_Mixed_idx" ON public."invalid_target" ("a");

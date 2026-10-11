-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY partial_a_idx ON partial_target (a);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY partial_missing_idx ON partial_target (no_such_column);

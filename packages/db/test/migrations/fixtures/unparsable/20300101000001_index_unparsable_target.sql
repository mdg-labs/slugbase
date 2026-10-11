-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY unparsable_a_idx ON unparsable_target (a);
--> statement-breakpoint
DROP INDEX unparsable_a_idx;

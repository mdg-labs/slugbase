-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "audit_events_target_id_idx" ON "audit_events" USING btree (lower("metadata" ->> 'targetId')) WHERE "audit_events"."metadata" ->> 'targetId' IS NOT NULL;

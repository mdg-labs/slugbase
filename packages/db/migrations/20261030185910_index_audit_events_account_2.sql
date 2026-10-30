-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "audit_events_entity_id_idx" ON "audit_events" USING btree ("entity_id") WHERE "audit_events"."entity_id" IS NOT NULL;

-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "audit_events_transfer_to_idx" ON "audit_events" USING btree (lower("metadata" ->> 'transferTo')) WHERE "audit_events"."metadata" ->> 'transferTo' IS NOT NULL;

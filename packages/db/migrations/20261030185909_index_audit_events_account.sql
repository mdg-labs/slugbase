-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "audit_events_actor_account_id_idx" ON "audit_events" USING btree ("actor_account_id") WHERE "audit_events"."actor_account_id" IS NOT NULL;

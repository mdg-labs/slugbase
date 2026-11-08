-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "sessions_absolute_expires_at_idx" ON "sessions" USING btree ("absolute_expires_at");

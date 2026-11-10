-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_owner_archived_idx" ON "bookmarks" USING btree ("workspace_id","owner_id","id") WHERE "bookmarks"."plan_archived_at" IS NOT NULL;

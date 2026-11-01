-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_owner_url_idx" ON "bookmarks" USING btree ("workspace_id","owner_id","url_canonical") WHERE "bookmarks"."plan_archived_at" IS NULL;

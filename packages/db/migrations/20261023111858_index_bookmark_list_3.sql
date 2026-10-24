-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_owner_popular_idx" ON "bookmarks" USING btree ("workspace_id","owner_id","open_count" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "bookmarks"."plan_archived_at" IS NULL;

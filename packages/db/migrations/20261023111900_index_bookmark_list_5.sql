-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_pinned_idx" ON "bookmarks" USING btree ("workspace_id","owner_id","pinned_at" DESC NULLS LAST) WHERE "bookmarks"."pinned_at" IS NOT NULL AND "bookmarks"."plan_archived_at" IS NULL;

-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_owner_opened_idx" ON "bookmarks" USING btree ("workspace_id","owner_id","last_opened_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "bookmarks"."plan_archived_at" IS NULL;

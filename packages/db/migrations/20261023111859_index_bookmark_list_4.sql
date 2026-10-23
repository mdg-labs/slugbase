-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_owner_title_idx" ON "bookmarks" USING btree ("workspace_id","owner_id",lower("title"),"id");

-- slugbase:non-transactional
CREATE UNIQUE INDEX CONCURRENTLY "bookmarks_owner_slug_key" ON "bookmarks" USING btree ("workspace_id","owner_id",slug) NULLS NOT DISTINCT WHERE (slug IS NOT NULL);

-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_search_idx" ON "bookmarks" USING gin ("workspace_id","search");

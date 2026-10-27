-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_title_trgm_idx" ON "bookmarks" USING gin ("workspace_id","title" gin_trgm_ops);

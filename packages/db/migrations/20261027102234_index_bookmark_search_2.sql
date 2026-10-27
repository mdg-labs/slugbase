-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_slug_trgm_idx" ON "bookmarks" USING gin ("workspace_id","slug" gin_trgm_ops);

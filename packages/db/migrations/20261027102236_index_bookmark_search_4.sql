-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_host_trgm_idx" ON "bookmarks" USING gin ("workspace_id","host" gin_trgm_ops);

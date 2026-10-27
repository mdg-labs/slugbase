-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_title_slug_search_idx" ON "bookmarks" USING gin ("workspace_id",(to_tsvector('simple', coalesce("slug", '')) || to_tsvector('simple', "title")));

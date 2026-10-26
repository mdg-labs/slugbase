-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "bookmarks_slug_idx" ON "bookmarks" USING btree ("workspace_id",slug) INCLUDE (id, owner_id, url, forwarding, plan_archived_at) WHERE (slug IS NOT NULL);

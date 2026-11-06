-- slugbase:non-transactional
CREATE INDEX CONCURRENTLY "workspaces_created_by_idx" ON "workspaces" USING btree ("created_by") WHERE "workspaces"."created_by" IS NOT NULL;

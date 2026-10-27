-- The system operation behind GET /go/suggest (doc 02 section 9.2, doc 04 section 10.8, doc 05 sections 3.3 and 4, doc 10 T1, T2 and T12). It is entered in src/system/registry.ts.
-- slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of that statement.
--
-- Why a system operation: the policy of bookmarks is FORCEd, and `LIKE` (textlike) is not leakproof, so as slugbase_app a prefix condition on the slug is never an index condition: the btree
-- bookmarks_slug_idx would be walked for the whole workspace and every slug filtered, and the trigram index would serve the workspace alone. slugbase_system bypasses the policies, so the prefix
-- condition is an index condition of bookmarks_slug_trgm_idx (a btree in a database whose collation is not C cannot serve a prefix at all). The function itself is the boundary: the workspace
-- and the account come from the settings of the transaction (app_workspace_id() and app_account_id(), never an argument), the candidates are those of the resolution of a slug (forwarding on,
-- not plan-archived, doc 05 section 4) and the access rule is the one of POST /go/resolve (a bookmark is readable by its owner today, bookmarkReadableBy in
-- src/repositories/bookmark-access.ts and the candidate scan of src/repositories/go.ts; sharing extends all three together).
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_go_suggest(p_prefix): at most 10 bookmarks of the active workspace whose slug starts with the prefix, that forward, are not plan-archived and that the calling account can read, as the
-- columns the palette shows: the identifier, slug, title and host of the destination, the owner (identifier and display name) and how the account reads the bookmark (access, `owner` today).
-- The candidates are the first 50 bookmarks with the prefix, the account's own first and then by the bytes of the slug (collation "C", so the order is the same in every database), and the access
-- rule is applied to them afterwards, so the work is bounded whatever the workspace holds and the rule is the one place sharing widens. The answer is in the same order. The prefix is trimmed
-- and lower-cased, and has its `\`, `%` and `_` escaped before it is a `LIKE` pattern, so no character of it is a wildcard. The function answers nothing outside withTenant() (no account or no
-- workspace is set) and for an empty prefix, and reads and writes nothing but bookmarks and, for the owner's name, accounts.
--
-- The plan is pinned for the function's own run. Sequential scans, index scans and index-only scans are off, so that the prefix is read by a bitmap scan of bookmarks_slug_trgm_idx, where `LIKE`
-- is an index condition beside the workspace. Without it the planner may choose a walk of bookmarks_slug_idx, which holds the slug and the columns of the candidate rule, with the prefix as a
-- filter: it reads every slug of the workspace and its cost is close enough to the trigram scan's for the choice to change with the statistics of the table.
CREATE OR REPLACE FUNCTION public.sys_go_suggest(p_prefix text)
  RETURNS TABLE (id uuid, slug text, title text, host text, owner_id uuid, owner_name text, access text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET enable_seqscan = off
  SET enable_indexscan = off
  SET enable_indexonlyscan = off
  AS $$
#variable_conflict use_column
DECLARE
  v_workspace uuid := public.app_workspace_id();
  v_account uuid := public.app_account_id();
  v_prefix text := lower(btrim(coalesce(p_prefix, '')));
  v_pattern text;
BEGIN
  IF v_workspace IS NULL OR v_account IS NULL OR v_prefix = '' THEN
    RETURN;
  END IF;
  v_pattern := replace(replace(replace(v_prefix, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  WITH candidates AS (
    SELECT b.id, b.slug, b.title, b.host, b.owner_id
    FROM public.bookmarks b
    WHERE b.workspace_id = v_workspace AND b.slug LIKE v_pattern || '%' AND b.forwarding AND b.plan_archived_at IS NULL
    ORDER BY b.owner_id IS NOT DISTINCT FROM v_account DESC, b.slug COLLATE "C", b.id
    LIMIT 50
  ), readable AS (
    SELECT c.id, c.slug, c.title, c.host, c.owner_id
    FROM candidates c
    WHERE c.owner_id = v_account
    ORDER BY c.slug COLLATE "C", c.id
    LIMIT 10
  )
  SELECT r.id, r.slug, r.title, r.host, r.owner_id, a.display_name, 'owner'::text
  FROM readable r
  LEFT JOIN public.accounts a ON a.id = r.owner_id
  ORDER BY r.slug COLLATE "C", r.id;
END
$$;

ALTER FUNCTION public.sys_go_suggest(text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_go_suggest(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_go_suggest(text) TO slugbase_app;

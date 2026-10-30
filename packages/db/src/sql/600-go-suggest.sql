-- The system operation behind GET /go/suggest (doc 02 section 9.2, doc 04 section 10.8, doc 05 sections 3.3 and 4, doc 10 T1, T2 and T12). It is entered in src/system/registry.ts.
-- slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of that statement.
--
-- Why a system operation: the policy of bookmarks is FORCEd, and `LIKE` (textlike) is not leakproof, so as slugbase_app a prefix condition on the slug is never an index condition: the btree
-- bookmarks_slug_idx would be walked for the whole workspace and every slug filtered, and the trigram index would serve the workspace alone. slugbase_system bypasses the policies, so the prefix
-- condition is an index condition of bookmarks_slug_trgm_idx (a btree in a database whose collation is not C cannot serve a prefix at all). The function itself is the boundary: the workspace
-- and the account come from the settings of the transaction (app_workspace_id() and app_account_id(), never an argument), the candidates are those of the resolution of a slug (forwarding on,
-- not plan-archived, doc 05 section 4) and the access rule is the one of POST /go/resolve (a bookmark is readable by its owner or by an account it is shared with, which is
-- bookmarkReadableBy in src/repositories/bookmark-access.ts, and the candidate scan of src/repositories/go.ts reads through it; this function states it in SQL and the three are changed together).
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_go_suggest(p_prefix): at most 10 bookmarks of the active workspace whose slug starts with the prefix, that forward, are not plan-archived and that the calling account can read, as the
-- columns the palette shows: the identifier, slug, title and host of the destination, the owner (identifier and display name) and how the account reads the bookmark (access: `owner`, `direct`, `team` or `folder`, the route that gives it, the direct share before the team's before the folder's).
-- The answer is the account's own first and then the ones shared with it, each by the bytes of the slug (collation "C", so the order is the same in every database). The account's own are the
-- first 10 of its bookmarks with the prefix; the shared ones are read from the set of the grants to the account, which holds the bookmarks of the four share statements of grantsTo in
-- src/repositories/bookmark-access.ts, probing bookmarks by primary key for each of them, and are the first 10 of those with the prefix, so the work is bounded whatever the workspace holds
-- and another member's private bookmark never takes a place of a suggestion. The prefix is trimmed
-- and lower-cased, and has its `\`, `%` and `_` escaped before it is a `LIKE` pattern, so no character of it is a wildcard. The function answers nothing outside withTenant() (no account or no
-- workspace is set) and for an empty prefix, and writes nothing and reads nothing but bookmarks, the share, folder-filing and team-member tables and, for the owner's name, accounts.
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
  WITH own AS (
    SELECT b.id, b.slug, b.title, b.host, b.owner_id, 'owner'::text AS access
    FROM public.bookmarks b
    WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.slug LIKE v_pattern || '%' AND b.forwarding AND b.plan_archived_at IS NULL
    ORDER BY b.slug COLLATE "C", b.id
    LIMIT 10
  ), grants AS (
    SELECT s.bookmark_id, 'direct'::text AS via FROM public.bookmark_shares s WHERE s.workspace_id = v_workspace AND s.target_account_id = v_account
    UNION ALL
    SELECT s.bookmark_id, 'team'::text FROM public.bookmark_shares s
    WHERE s.workspace_id = v_workspace
      AND s.target_team_id IN (SELECT m.team_id FROM public.team_members m WHERE m.workspace_id = v_workspace AND m.account_id = v_account)
    UNION ALL
    SELECT fb.bookmark_id, 'folder'::text FROM public.folder_shares fs
    JOIN public.folder_bookmarks fb ON fb.workspace_id = fs.workspace_id AND fb.folder_id = fs.folder_id
    WHERE fs.workspace_id = v_workspace AND fs.target_account_id = v_account
    UNION ALL
    SELECT fb.bookmark_id, 'folder'::text FROM public.folder_shares fs
    JOIN public.folder_bookmarks fb ON fb.workspace_id = fs.workspace_id AND fb.folder_id = fs.folder_id
    WHERE fs.workspace_id = v_workspace
      AND fs.target_team_id IN (SELECT m.team_id FROM public.team_members m WHERE m.workspace_id = v_workspace AND m.account_id = v_account)
  ), via AS (
    SELECT DISTINCT ON (g.bookmark_id) g.bookmark_id, g.via
    FROM grants g
    ORDER BY g.bookmark_id, CASE g.via WHEN 'direct' THEN 0 WHEN 'team' THEN 1 ELSE 2 END
  ), shared AS (
    SELECT b.id, b.slug, b.title, b.host, b.owner_id, v.via AS access
    FROM via v
    JOIN public.bookmarks b ON b.workspace_id = v_workspace AND b.id = v.bookmark_id
    WHERE b.slug LIKE v_pattern || '%' AND b.forwarding AND b.plan_archived_at IS NULL AND b.owner_id IS DISTINCT FROM v_account
    ORDER BY b.slug COLLATE "C", b.id
    LIMIT 10
  ), readable AS (
    SELECT * FROM own
    UNION ALL
    SELECT * FROM shared
  )
  SELECT r.id, r.slug, r.title, r.host, r.owner_id, a.display_name, r.access
  FROM readable r
  LEFT JOIN public.accounts a ON a.id = r.owner_id
  ORDER BY r.access <> 'owner', r.slug COLLATE "C", r.id
  LIMIT 10;
END
$$;

ALTER FUNCTION public.sys_go_suggest(text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_go_suggest(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_go_suggest(text) TO slugbase_app;

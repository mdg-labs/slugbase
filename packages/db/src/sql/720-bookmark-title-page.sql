-- The system operation behind a page of GET /bookmarks that resumes a sort by title (doc 02 section 5.7, doc 05 sections 2.4 and 4, doc 08 section 5.3, doc 10 T1 and T2). It is entered in
-- src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of that statement.
--
-- Why a system operation: the policy of bookmarks is FORCEd, and a condition of a query is an index condition for slugbase_app only if everything in it is leakproof. lower(text) is not, so as
-- slugbase_app the keyset condition `(lower(title), id) > (key, id)` of bookmarks_owner_title_idx is a filter over what the index returns for the owner: a page at depth 40 000 reads 40 000 entries to drop
-- them (about 40 500 blocks). slugbase_system bypasses the policy, so the same condition is an index condition and the page reads the entries it returns (57 to 58 blocks for a page of 49). The function itself is the
-- boundary: the workspace and the account come from the settings of the transaction (app_workspace_id() and app_account_id(), never an argument), the rows are the account's own bookmarks in that
-- workspace that are not plan-archived, which is the scope `mine` of the list (bookmarkReadableBy and branchPredicate in src/repositories/bookmarks.ts, which this function states in SQL and the two are
-- changed together), and the policy of bookmarks (the workspace) is the first term of the condition. The only parameters are the direction, the place the page resumes after and the size of the page.
--
-- It answers the columns of a bookmark record as the list reads them, in the order of the sort (lower(title) and then the identifier, both ascending or both descending), starting after the place given:
-- the lower-cased title of the last row of the page before and its identifier, compared as a row exactly as the keyset of the list compares them. The cursor is required: the first page of the list
-- has no keyset condition and is served by the index as slugbase_app. The function answers nothing outside withTenant() (no account or no workspace is set), writes nothing and reads nothing but bookmarks.
--
-- The plan is pinned for the function's own run. Sequential scans, bitmap scans and sorts are off, so the page is read in order from bookmarks_owner_title_idx and cut at the limit; with that the plan has one
-- shape whatever the key, the identifier and the limit of the call are, so the function does not need the plan made for the values of each call that sys_search sets (plan_cache_mode, src/sql/590-search.sql):
-- the test of a connection's calls past the fifth holds each to the blocks of a page (doc 08 section 5.3).
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.sys_bookmark_title_page(p_descending boolean, p_key text, p_id uuid, p_limit integer)
  RETURNS TABLE (
    id uuid, owner_id uuid, url text, host text, title text, description text, slug text, forwarding boolean, pinned_at timestamptz,
    open_count bigint, last_opened_at timestamptz, version integer, created_at timestamptz, updated_at timestamptz
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET enable_seqscan = off
  SET enable_bitmapscan = off
  SET enable_sort = off
  AS $$
#variable_conflict use_column
DECLARE
  v_workspace uuid := public.app_workspace_id();
  v_account uuid := public.app_account_id();
BEGIN
  IF p_descending IS NULL OR p_key IS NULL OR p_id IS NULL OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'sys_bookmark_title_page needs a direction, a place to resume after and a limit of at least one'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_workspace IS NULL OR v_account IS NULL THEN
    RETURN;
  END IF;

  IF p_descending THEN
    RETURN QUERY
    SELECT b.id, b.owner_id, b.url, b.host, b.title, b.description, b.slug, b.forwarding, b.pinned_at, b.open_count, b.last_opened_at, b.version, b.created_at, b.updated_at
    FROM public.bookmarks b
    WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND (lower(b.title), b.id) < (p_key, p_id)
    ORDER BY lower(b.title) DESC, b.id DESC
    LIMIT p_limit;
  ELSE
    RETURN QUERY
    SELECT b.id, b.owner_id, b.url, b.host, b.title, b.description, b.slug, b.forwarding, b.pinned_at, b.open_count, b.last_opened_at, b.version, b.created_at, b.updated_at
    FROM public.bookmarks b
    WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND (lower(b.title), b.id) > (p_key, p_id)
    ORDER BY lower(b.title), b.id
    LIMIT p_limit;
  END IF;
END
$$;

ALTER FUNCTION public.sys_bookmark_title_page(boolean, text, uuid, integer) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_bookmark_title_page(boolean, text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_bookmark_title_page(boolean, text, uuid, integer) TO slugbase_app;

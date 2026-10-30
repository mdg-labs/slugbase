-- The system operation behind the text query of GET /bookmarks (doc 02 sections 5.7 and 9.1, doc 04 section 6.2, doc 05 sections 2.4 and 3.3, doc 10 T1 and T2). It is entered in
-- src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of that statement.
--
-- Why a system operation: the same reason as sys_search (src/sql/590-search.sql). The policy of bookmarks is FORCEd and none of `@@`, `<%` and `LIKE` is leakproof, so as slugbase_app the GIN
-- indexes of the search serve the workspace alone and each search condition is a filter over every bookmark of it. slugbase_system bypasses the policies, so the function reads the indexes, and
-- the function itself is the boundary: the workspace and the account come from the settings of the transaction (app_workspace_id() and app_account_id(), never an argument), the access rule (the
-- bookmark is the account's own or is shared with it, bookmarkReadableBy in src/repositories/bookmark-access.ts, which this function states in SQL and the two are changed together) and the plan-archive
-- rule are in every branch, and the only parameter is the text of the query. It answers identifiers and nothing else of a bookmark. The access rule of every branch is `readable`: the account's own
-- bookmark, or one in the set of bookmarks shared with the account (directly, through a team of the account, through a shared folder it is filed in, or through a folder shared with a team of the
-- account), read once from the four share statements of grantsTo and held as a hashed lookup, as sys_search reads it. The scope of the list and its other filters (the folders, the tags, the pin)
-- are the statement's own, so a list of the account's own bookmarks keeps the matches that are its own.
--
-- The text is matched as sys_search matches it, so the list and the search agree on what a query finds: the text is cut to its first 100 characters, lower-cased and has its runs of white space made
-- one space, never SQL or tsquery syntax (the LIKE patterns escape `\`, `%` and `_`; the tsquery is built from the quoted lexemes of its first eight words, each given the prefix mark, and joined by `&`).
-- A bookmark matches when its slug is the text or starts with it, or the full-text vector `search` (slug and title weight A, host B, description C, the `simple` configuration, no URL path) holds
-- every word of it as a prefix. A list has no ranking to put the matches of a typo below the others, so the trigram matches (a word of the title or of the host that resembles the text, with the
-- word_similarity_threshold of sys_search, 0.4) are the matches of the query only when nothing else matches, which is what makes a typo find its bookmark and keeps a word that merely resembles
-- the text out of a list of bookmarks that hold it. A text of fewer than three characters (after the whitespace around it is removed) has no full-text or trigram term and matches the slug exactly, the
-- slug by prefix and the title by prefix, without regard to case, only.
--
-- The set is the whole set of matches: it is not cut, so a list that resumes by a keyset misses none of them. The settings of the function turn sequential scans, index scans and index-only scans off for its own
-- run, so that every branch is read by a bitmap scan of its own index, as in sys_search. The answer is in no order and holds an identifier once (a bookmark is one row of one scan, so no step has to remove repeats). The function answers nothing outside withTenant() (no
-- account or no workspace is set) and for an empty text, and reads nothing but bookmarks and the share, folder-filing and team-member tables, and writes nothing.
GRANT CREATE ON SCHEMA public TO slugbase_system;

CREATE OR REPLACE FUNCTION public.sys_bookmark_match(p_query text)
  RETURNS TABLE (id uuid)
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
  v_text text := lower(btrim(regexp_replace(left(coalesce(p_query, ''), 100), '[[:space:]]+', ' ', 'g')));
  v_pattern text;
  v_tsquery tsquery;
  v_threshold text;
BEGIN
  IF v_workspace IS NULL OR v_account IS NULL OR v_text = '' THEN
    RETURN;
  END IF;
  v_pattern := replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_');

  IF char_length(v_text) < 3 THEN
    RETURN QUERY
    WITH readable AS MATERIALIZED (
    SELECT s.bookmark_id FROM public.bookmark_shares s WHERE s.workspace_id = v_workspace AND s.target_account_id = v_account
    UNION
    SELECT s.bookmark_id FROM public.bookmark_shares s
    WHERE s.workspace_id = v_workspace
      AND s.target_team_id IN (SELECT m.team_id FROM public.team_members m WHERE m.workspace_id = v_workspace AND m.account_id = v_account)
    UNION
    SELECT fb.bookmark_id FROM public.folder_shares fs
    JOIN public.folder_bookmarks fb ON fb.workspace_id = fs.workspace_id AND fb.folder_id = fs.folder_id
    WHERE fs.workspace_id = v_workspace AND fs.target_account_id = v_account
    UNION
    SELECT fb.bookmark_id FROM public.folder_shares fs
    JOIN public.folder_bookmarks fb ON fb.workspace_id = fs.workspace_id AND fb.folder_id = fs.folder_id
    WHERE fs.workspace_id = v_workspace
      AND fs.target_team_id IN (SELECT m.team_id FROM public.team_members m WHERE m.workspace_id = v_workspace AND m.account_id = v_account)
  )
    SELECT b.id FROM public.bookmarks b
    WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND (b.slug LIKE v_pattern || '%' OR b.title ILIKE v_pattern || '%');
    RETURN;
  END IF;

  SELECT string_agg('''' || replace(replace(l.lexeme, '\', '\\'), '''', '''''') || ''':*', ' & ')::tsquery
  INTO v_tsquery
  FROM (SELECT w.word FROM regexp_split_to_table(v_text, ' ') AS w(word) LIMIT 8) AS words,
       LATERAL unnest(tsvector_to_array(to_tsvector('simple', words.word))) AS l(lexeme);

  PERFORM public.similarity('', '');
  v_threshold := current_setting('pg_trgm.word_similarity_threshold');
  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.4', true);

  RETURN QUERY
  WITH readable AS MATERIALIZED (
    SELECT s.bookmark_id FROM public.bookmark_shares s WHERE s.workspace_id = v_workspace AND s.target_account_id = v_account
    UNION
    SELECT s.bookmark_id FROM public.bookmark_shares s
    WHERE s.workspace_id = v_workspace
      AND s.target_team_id IN (SELECT m.team_id FROM public.team_members m WHERE m.workspace_id = v_workspace AND m.account_id = v_account)
    UNION
    SELECT fb.bookmark_id FROM public.folder_shares fs
    JOIN public.folder_bookmarks fb ON fb.workspace_id = fs.workspace_id AND fb.folder_id = fs.folder_id
    WHERE fs.workspace_id = v_workspace AND fs.target_account_id = v_account
    UNION
    SELECT fb.bookmark_id FROM public.folder_shares fs
    JOIN public.folder_bookmarks fb ON fb.workspace_id = fs.workspace_id AND fb.folder_id = fs.folder_id
    WHERE fs.workspace_id = v_workspace
      AND fs.target_team_id IN (SELECT m.team_id FROM public.team_members m WHERE m.workspace_id = v_workspace AND m.account_id = v_account)
  ), strong AS MATERIALIZED (
    SELECT b.id FROM public.bookmarks b
    WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND (b.slug LIKE v_pattern || '%' OR b.search @@ v_tsquery)
  ), fuzzy AS (
    SELECT b.id FROM public.bookmarks b
    WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND (v_text <% b.title OR v_text <% b.host)
      AND NOT EXISTS (SELECT 1 FROM strong)
  )
  SELECT s.id FROM strong s
  UNION ALL
  SELECT f.id FROM fuzzy f;

  PERFORM set_config('pg_trgm.word_similarity_threshold', v_threshold, true);
END
$$;

ALTER FUNCTION public.sys_bookmark_match(text) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_bookmark_match(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_bookmark_match(text) TO slugbase_app;

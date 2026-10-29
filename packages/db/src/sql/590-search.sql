-- The system operation behind GET /search for bookmarks (doc 02 section 9.1, doc 04 section 10.8, doc 05 sections 2.4, 3.3 and 4, doc 10 T1 and T2, Q49). It is entered in
-- src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of that statement.
--
-- Why a system operation: the policy of bookmarks is FORCEd, and PostgreSQL uses a condition of a query as an index condition on a table with a policy only when its operator is
-- leakproof. The operators of the search, `@@` (ts_match_vq), `<%` (word_similarity_op) and `LIKE` (textlike), are not, so as slugbase_app the GIN indexes serve the workspace alone
-- and each search condition is a filter over every bookmark of the workspace (title trigrams took about 165 ms on 50 000 bookmarks against about 0.4 ms with the indexes in use).
-- slugbase_system bypasses the policies, so the function reads the indexes, and the function itself is the boundary: the workspace and the account come from the settings of the
-- transaction (app_workspace_id() and app_account_id(), never an argument), the access rule (the bookmark is the account's own or is shared with it, bookmarkReadableBy in
-- src/repositories/bookmark-access.ts, which this function states in SQL and the two are changed together) and the plan-archive rule are in every branch, and the only parameters are the text of the query and a limit.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_search(p_query, p_limit): at most p_limit (0 to 20) readable, not plan-archived bookmarks of the active workspace that match the query, best first, as the columns the search
-- shows: id, title, url, host, slug, forwarding and whether it is pinned (by the account itself). The rank is the order of doc 02 section 9.1: the query is exactly the slug (1), the slug starts with it (2), the
-- full-text vector `search` (the `simple` configuration; slug and title weight A, host B, description C) holds every word of it as a prefix (3, then by ts_rank_cd), and the title or the host
-- has a word that resembles it by trigrams (4, then by the better word similarity); the same title and then the identifier settle a tie. The full-text tier has two parts: the
-- bookmarks whose slug and title together hold every word, which come first and are all found, through the GIN index over that vector alone (bookmarks_title_slug_search_idx), and ranked
-- exactly, and then the bookmarks whose host or description (weight B and C, so they rank below) completes the words, which fill the places the first part leaves from a window of 300
-- of them. A broad word (a host prefix such as `www`, a phrase of the descriptions) matches tens of thousands of bookmarks all of one rank, and ranking each of them before the answer
-- is cut to p_limit took most of the time of the search; the window is only read when the first part, with the exact slug and the slug prefix, has not found p_limit bookmarks (inside the
-- function the window is tier 4 and the trigram match tier 5, so that the title and slug matches always come first). A query shorter than three characters
-- (after the whitespace around it is removed) has no full-text or trigram term and matches by prefix only: the slug is exactly it (1), the slug starts with it (2) or the title starts
-- with it, without regard to case (3).
--
-- The text is never SQL or tsquery syntax. It is cut to its first 100 characters, lower-cased, and has its runs of white space made one space. The LIKE patterns are made from it with
-- the characters `\`, `%` and `_` escaped. The tsquery is built from the lexemes that to_tsvector('simple', ...) finds in each of its first eight words, each lexeme quoted with the
-- quote and the backslash escaped and given the prefix mark, and joined by `&`, so no character of the text reaches the tsquery parser unquoted: `&`, `|`, `!`, `:*`, parentheses,
-- quotes and backslashes are plain text or are dropped as the parser drops punctuation, and a text without any lexeme matches nothing by full text. A trigram match needs the
-- pg_trgm threshold: the long form sets word_similarity_threshold to 0.4 for the transaction so that a typo in a word of the title still matches (the default of 0.6 is too strict for it),
-- and puts the previous value back when it is done. It is set in the body and not by a SET clause of the function because slugbase_owner may set a pg_trgm parameter only in a session in
-- which the library is loaded, and a session that upgrades a database in which pg_trgm is installed has not loaded it; the call of similarity() loads it. The function also turns
-- sequential scans, index scans and index-only scans off for its own run, so that every branch is read by a bitmap scan of its own index: without it a branch that is cut after 300 rows could
-- be planned as a walk of the workspace's bookmarks (by a btree, with the search condition as a filter) that stops only when it has found 300, which for a query that few bookmarks resemble
-- reads them all, and for the window of host and description matches the planner chose exactly that. The slug-prefix branches of both forms and the title-prefix branch of the short form sort by
-- `lower(b.title) || ''`, which is not the expression of bookmarks_owner_title_idx: a sort by it would let the planner walk the titles in order and filter every bookmark before the first
-- match (on some samples of ANALYZE it did, reading tens of thousands of rows for a slug prefix few slugs have), and the trigram indexes, which hold the prefix of a slug and of a title,
-- are what serve the branch.
--
-- Each of the first three branches is cut to p_limit rows before the branches are joined, which is enough: a bookmark at position n of the answer is within n of the top of the branch of
-- its best rank. The window of host and description matches and the trigram branches come last in the order and can only fill what the others leave, so they are not run at all when the
-- branches before them have found p_limit bookmarks, and each looks at the first 300 bookmarks its index finds: a typo in a word finds few bookmarks, and a broad query that finds thousands is answered by the full text before them. The
-- access rule of every branch is `readable`: the account's own bookmark, or one in the set of bookmarks shared with the account (directly, through a team of the account, or through a
-- shared folder it is filed in, or through a folder shared with a team of the account), read once from the four share statements of grantsTo and held as a hashed lookup, so a branch's
-- condition is a filter on the rows its index finds and sharing changes no index choice. A pin is the owner's (Q22), so a bookmark shared with the account is never pinned in its answer. The
-- function answers nothing outside withTenant() (no account or no workspace is set), for an empty text and for a limit of 0, and writes nothing and reads nothing but bookmarks and the share, folder-filing and team-member tables.
CREATE OR REPLACE FUNCTION public.sys_search(p_query text, p_limit integer)
  RETURNS TABLE (id uuid, title text, url text, host text, slug text, forwarding boolean, pinned boolean)
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
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 20);
  v_pattern text;
  v_tsquery tsquery;
  v_threshold text;
BEGIN
  IF v_workspace IS NULL OR v_account IS NULL OR v_text = '' OR v_limit = 0 THEN
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
  ), hits AS (
      (SELECT b.id, 1 AS tier, 0::real AS score FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND b.slug = v_text
       ORDER BY lower(b.title), b.id LIMIT v_limit)
      UNION ALL
      (SELECT b.id, 2, 0::real FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND b.slug LIKE v_pattern || '%'
       ORDER BY lower(b.title) || '', b.id LIMIT v_limit)
      UNION ALL
      (SELECT b.id, 3, 0::real FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND b.title ILIKE v_pattern || '%'
       ORDER BY lower(b.title) || '', b.id LIMIT v_limit)
    ), best AS (
      SELECT DISTINCT ON (h.id) h.id, h.tier, h.score FROM hits h ORDER BY h.id, h.tier
    )
    SELECT b.id, b.title, b.url, b.host, b.slug, b.forwarding, b.pinned_at IS NOT NULL AND b.owner_id IS NOT DISTINCT FROM v_account
    FROM best JOIN public.bookmarks b ON b.workspace_id = v_workspace AND b.id = best.id
    ORDER BY best.tier, lower(b.title), b.id
    LIMIT v_limit;
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
  ), head AS MATERIALIZED (
    SELECT DISTINCT ON (h.id) h.id, h.tier, h.score
    FROM (
      (SELECT b.id, 1 AS tier, 0::real AS score FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND b.slug = v_text
       ORDER BY lower(b.title), b.id LIMIT v_limit)
      UNION ALL
      (SELECT b.id, 2, 0::real FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND b.slug LIKE v_pattern || '%'
       ORDER BY lower(b.title) || '', b.id LIMIT v_limit)
      UNION ALL
      (SELECT b.id, 3, ts_rank_cd(b.search, v_tsquery)::real FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL
         AND (to_tsvector('simple', coalesce(b.slug, '')) || to_tsvector('simple', b.title)) @@ v_tsquery
       ORDER BY 3 DESC, lower(b.title), b.id LIMIT v_limit)
    ) h
    ORDER BY h.id, h.tier, h.score DESC
  ), wide AS (
    SELECT w.id, 4 AS tier, ts_rank_cd(w.search, v_tsquery)::real AS score
    FROM (SELECT b.id, b.title, b.search FROM public.bookmarks b
          WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND b.search @@ v_tsquery
            AND (SELECT count(*) FROM head) < v_limit
          LIMIT 300) w
    ORDER BY 3 DESC, lower(w.title), w.id LIMIT v_limit
  ), strong AS MATERIALIZED (
    SELECT DISTINCT ON (h.id) h.id, h.tier, h.score
    FROM (SELECT * FROM head UNION ALL SELECT * FROM wide) h
    ORDER BY h.id, h.tier, h.score DESC
  ), fuzzy AS (
    (SELECT b.id, 5 AS tier, word_similarity(v_text, b.title)::real AS score FROM public.bookmarks b
     WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND v_text <% b.title
       AND (SELECT count(*) FROM strong) < v_limit
     LIMIT 300)
    UNION ALL
    (SELECT b.id, 5, word_similarity(v_text, b.host)::real FROM public.bookmarks b
     WHERE b.workspace_id = v_workspace AND (b.owner_id = v_account OR b.id IN (SELECT r.bookmark_id FROM readable r)) AND b.plan_archived_at IS NULL AND v_text <% b.host
       AND (SELECT count(*) FROM strong) < v_limit
     LIMIT 300)
  ), best AS (
    SELECT DISTINCT ON (h.id) h.id, h.tier, h.score
    FROM (SELECT * FROM strong UNION ALL SELECT * FROM fuzzy) h
    ORDER BY h.id, h.tier, h.score DESC
  )
  SELECT b.id, b.title, b.url, b.host, b.slug, b.forwarding, b.pinned_at IS NOT NULL AND b.owner_id IS NOT DISTINCT FROM v_account
  FROM best JOIN public.bookmarks b ON b.workspace_id = v_workspace AND b.id = best.id
  ORDER BY best.tier, best.score DESC, lower(b.title), b.id
  LIMIT v_limit;

  PERFORM set_config('pg_trgm.word_similarity_threshold', v_threshold, true);
END
$$;

ALTER FUNCTION public.sys_search(text, integer) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_search(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_search(text, integer) TO slugbase_app;

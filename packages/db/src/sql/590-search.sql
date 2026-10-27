-- The system operation behind GET /search for bookmarks (doc 02 section 9.1, doc 04 section 10.8, doc 05 sections 2.4, 3.3 and 4, doc 10 T1 and T2, Q49). It is entered in
-- src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of that statement.
--
-- Why a system operation: the policy of bookmarks is FORCEd, and PostgreSQL uses a condition of a query as an index condition on a table with a policy only when its operator is
-- leakproof. The operators of the search, `@@` (ts_match_vq), `<%` (word_similarity_op) and `LIKE` (textlike), are not, so as slugbase_app the GIN indexes serve the workspace alone
-- and each search condition is a filter over every bookmark of the workspace (title trigrams took about 165 ms on 50 000 bookmarks against about 0.4 ms with the indexes in use).
-- slugbase_system bypasses the policies, so the function reads the indexes, and the function itself is the boundary: the workspace and the account come from the settings of the
-- transaction (app_workspace_id() and app_account_id(), never an argument), the access rule (the bookmark is the account's own today, bookmarkReadableBy in
-- src/repositories/bookmark-access.ts; sharing extends both together) and the plan-archive rule are in every branch, and the only parameters are the text of the query and a limit.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_search(p_query, p_limit): at most p_limit (0 to 20) readable, not plan-archived bookmarks of the active workspace that match the query, best first, as the columns the search
-- shows: id, title, url, host, slug, forwarding and whether it is pinned. The rank is the order of doc 02 section 9.1: the query is exactly the slug (1), the slug starts with it (2), the
-- full-text vector `search` (the `simple` configuration; slug and title weight A, host B, description C) holds every word of it as a prefix (3, then by ts_rank_cd), and the title or the host
-- has a word that resembles it by trigrams (4, then by the better word similarity); the same title and then the identifier settle a tie. A query shorter than three characters
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
-- sequential scans off for its own run: every branch has an index, and without it a branch that is cut after 300 rows could be planned as a scan of all the workspace's bookmarks that stops
-- only when it has found 300, which for a query that few bookmarks resemble reads them all. The prefix branches of the short form sort by `lower(b.title) || ''`, which is not the expression
-- of bookmarks_owner_title_idx: a sort by it would let the planner walk the titles in order and filter every bookmark before the first match, and the trigram indexes, which hold the
-- prefix of a slug and of a title, are what serve the branch.
--
-- Each of the first three branches is cut to p_limit rows before the branches are joined, which is enough: a bookmark at position n of the answer is within n of the top of the branch of
-- its best rank. The trigram branches come last in the order and can only fill what the others leave, so they are not run at all when the first three have found p_limit bookmarks, and
-- each looks at the first 300 bookmarks its index finds: a typo in a word finds few bookmarks, and a broad query that finds thousands is answered by the full text before them. The
-- function answers nothing outside withTenant() (no account or no workspace is set), for an empty text and for a limit of 0, and reads and writes nothing but bookmarks.
CREATE OR REPLACE FUNCTION public.sys_search(p_query text, p_limit integer)
  RETURNS TABLE (id uuid, title text, url text, host text, slug text, forwarding boolean, pinned boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  SET enable_seqscan = off
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
    WITH hits AS (
      (SELECT b.id, 1 AS tier, 0::real AS score FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND b.slug = v_text
       ORDER BY lower(b.title), b.id LIMIT v_limit)
      UNION ALL
      (SELECT b.id, 2, 0::real FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND b.slug LIKE v_pattern || '%'
       ORDER BY lower(b.title) || '', b.id LIMIT v_limit)
      UNION ALL
      (SELECT b.id, 3, 0::real FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND b.title ILIKE v_pattern || '%'
       ORDER BY lower(b.title) || '', b.id LIMIT v_limit)
    ), best AS (
      SELECT DISTINCT ON (h.id) h.id, h.tier, h.score FROM hits h ORDER BY h.id, h.tier
    )
    SELECT b.id, b.title, b.url, b.host, b.slug, b.forwarding, b.pinned_at IS NOT NULL
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
  WITH strong AS MATERIALIZED (
    SELECT DISTINCT ON (h.id) h.id, h.tier, h.score
    FROM (
      (SELECT b.id, 1 AS tier, 0::real AS score FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND b.slug = v_text
       ORDER BY lower(b.title), b.id LIMIT v_limit)
      UNION ALL
      (SELECT b.id, 2, 0::real FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND b.slug LIKE v_pattern || '%'
       ORDER BY lower(b.title), b.id LIMIT v_limit)
      UNION ALL
      (SELECT b.id, 3, ts_rank_cd(b.search, v_tsquery)::real FROM public.bookmarks b
       WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND b.search @@ v_tsquery
       ORDER BY 3 DESC, lower(b.title), b.id LIMIT v_limit)
    ) h
    ORDER BY h.id, h.tier, h.score DESC
  ), fuzzy AS (
    (SELECT b.id, 4 AS tier, word_similarity(v_text, b.title)::real AS score FROM public.bookmarks b
     WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND v_text <% b.title
       AND (SELECT count(*) FROM strong) < v_limit
     LIMIT 300)
    UNION ALL
    (SELECT b.id, 4, word_similarity(v_text, b.host)::real FROM public.bookmarks b
     WHERE b.workspace_id = v_workspace AND b.owner_id = v_account AND b.plan_archived_at IS NULL AND v_text <% b.host
       AND (SELECT count(*) FROM strong) < v_limit
     LIMIT 300)
  ), best AS (
    SELECT DISTINCT ON (h.id) h.id, h.tier, h.score
    FROM (SELECT * FROM strong UNION ALL SELECT * FROM fuzzy) h
    ORDER BY h.id, h.tier, h.score DESC
  )
  SELECT b.id, b.title, b.url, b.host, b.slug, b.forwarding, b.pinned_at IS NOT NULL
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

-- The system operation behind the usage counter of bookmarks (doc 01 section 8.1, doc 02 section 5.5, doc 05 sections 2.4 and 3.3,
-- doc 10 section 5 residual 1, T1 and T12, Q28). It is entered in src/system/registry.ts. slugbase_owner creates the function and hands
-- it to slugbase_system, which needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_flush_open_counts(bookmark_ids, counts, last_opened): adds counts[i] to the open_count of bookmark bookmark_ids[i] and moves its
-- last_opened_at to last_opened[i] when that is later than the one the row has, for every position of the three arrays, in one
-- statement across workspaces, and answers how many bookmarks it updated. slugbase_app has no privilege on bookmarks.open_count or
-- bookmarks.last_opened_at, so the usage can only move through this call. It is not a tenant operation: each server process flushes
-- the opens it buffered, which may name bookmarks of any workspace, from a connection that acts in none, so it takes no workspace and
-- no account. Whether an open may be recorded is decided before it is buffered, by the read access of the caller; this function
-- trusts none of its input beyond its shape and writes nothing else of a bookmark (the version stays, since a usage change is not
-- one the ETag covers; updated_at moves with every update of the row, as set_updated_at() makes it). It keeps a count and the
-- latest timestamp and nothing else: no history, referrer or address (Q28). The arrays must be as long as each other, not NULL, hold no
-- NULL element and no count below one, and hold at most 10 000 positions; anything else is refused with invalid_parameter_value and
-- writes nothing. A position that names no bookmark (it was deleted since the open) is skipped, and a bookmark named more than once adds
-- up. The rows are locked in the order of their identifiers before the first is written, so two flushes queue on one another and
-- do not deadlock; a flush that meets a concurrent change of the same bookmarks in another order fails with the database's error and
-- the caller keeps its counts for the next flush.
CREATE OR REPLACE FUNCTION public.sys_flush_open_counts(p_bookmark_ids uuid[], p_counts bigint[], p_last_opened timestamptz[])
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_updated bigint;
BEGIN
  IF p_bookmark_ids IS NULL OR p_counts IS NULL OR p_last_opened IS NULL THEN
    RAISE EXCEPTION 'sys_flush_open_counts needs three lists'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(p_bookmark_ids) <> cardinality(p_counts) OR cardinality(p_bookmark_ids) <> cardinality(p_last_opened) THEN
    RAISE EXCEPTION 'sys_flush_open_counts needs lists of the same length'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(p_bookmark_ids) > 10000 THEN
    RAISE EXCEPTION 'sys_flush_open_counts takes at most 10000 bookmarks'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_bookmark_ids, p_counts, p_last_opened) AS u(bookmark_id, open_count, opened_at)
    WHERE u.bookmark_id IS NULL OR u.open_count IS NULL OR u.open_count < 1 OR u.opened_at IS NULL
  ) THEN
    RAISE EXCEPTION 'sys_flush_open_counts needs a bookmark, a count of at least one and a time at every position'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM public.bookmarks b
  WHERE b.id = ANY (p_bookmark_ids)
  ORDER BY b.id
  FOR NO KEY UPDATE;

  UPDATE public.bookmarks b
  SET open_count = b.open_count + usage.added, last_opened_at = greatest(b.last_opened_at, usage.latest)
  FROM (
    SELECT u.bookmark_id, sum(u.open_count)::bigint AS added, max(u.opened_at) AS latest
    FROM unnest(p_bookmark_ids, p_counts, p_last_opened) AS u(bookmark_id, open_count, opened_at)
    GROUP BY u.bookmark_id
  ) AS usage
  WHERE b.id = usage.bookmark_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END
$$;

ALTER FUNCTION public.sys_flush_open_counts(uuid[], bigint[], timestamptz[]) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_flush_open_counts(uuid[], bigint[], timestamptz[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_flush_open_counts(uuid[], bigint[], timestamptz[]) TO slugbase_app;

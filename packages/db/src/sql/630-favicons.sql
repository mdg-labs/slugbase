-- Row-level security, privileges and system operations of the favicon cache (doc 05 sections 2.7 and 3.3, doc 02 section 5.4, doc 10 T6 and T14).
-- The table is defined in src/schema/favicons.ts. Both functions are entered in src/system/registry.ts. slugbase_owner creates each function and
-- hands it to slugbase_system, which needs CREATE on the schema for the length of those statements.
--
-- favicons is deployment-wide, one row for each host, so it has no tenant policy: row-level security is enabled and forced and the table has no
-- policy, and slugbase_app holds no privilege on it. sys_favicon_get and sys_favicon_put are its only users; sys_retention_purge deletes a row once
-- it has expired (110-retention-purge.sql), and its FOR UPDATE SKIP LOCKED is why slugbase_system holds UPDATE as well.
ALTER TABLE public.favicons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favicons FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.favicons FROM PUBLIC, slugbase_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.favicons TO slugbase_system;

GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_favicon_get(host, size): the row of the host when it has not expired by the database clock, as its status and the PNG of the size asked
-- for, 32 or 64 pixels (null for a host with no icon); no row for an unknown or expired host. Any other size is refused with
-- invalid_parameter_value. The host is compared as given: the caller passes it in lower case.
CREATE OR REPLACE FUNCTION public.sys_favicon_get(p_host text, p_size integer)
  RETURNS TABLE (status text, content bytea)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  IF p_size IS NULL OR p_size NOT IN (32, 64) THEN
    RAISE EXCEPTION 'sys_favicon_get needs a size of 32 or 64 pixels'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT f.status, CASE WHEN p_size = 32 THEN f.content_32 ELSE f.content END
  FROM public.favicons f
  WHERE f.host = p_host AND f.expires_at > clock_timestamp();
END
$$;

-- sys_favicon_put(host, status, content, content_32): stores the result of a fetch for the host, replacing an earlier row, with fetched_at and
-- expires_at (seven days later) from the database clock. A host must be a lower-case host name of at most 253 characters. Status ok needs both
-- PNGs, each of at most 65 536 bytes and starting with the PNG signature, so nothing but a PNG is ever served; status none needs neither. Any
-- other argument is refused with invalid_parameter_value, changing nothing.
CREATE OR REPLACE FUNCTION public.sys_favicon_put(p_host text, p_status text, p_content bytea, p_content_32 bytea)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  c_png_signature CONSTANT bytea := '\x89504e470d0a1a0a';
  c_max_bytes CONSTANT integer := 65536;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT coalesce(
    p_host IS NOT NULL
    AND length(p_host) BETWEEN 1 AND 253
    AND p_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
    AND (
      (p_status = 'ok'
        AND p_content IS NOT NULL AND p_content_32 IS NOT NULL
        AND octet_length(p_content) BETWEEN 9 AND c_max_bytes AND octet_length(p_content_32) BETWEEN 9 AND c_max_bytes
        AND substring(p_content FROM 1 FOR 8) = c_png_signature AND substring(p_content_32 FROM 1 FOR 8) = c_png_signature)
      OR (p_status = 'none' AND p_content IS NULL AND p_content_32 IS NULL)
    ),
    false
  ) THEN
    RAISE EXCEPTION 'sys_favicon_put needs a lower-case host name and either status ok with two PNGs of at most 65536 bytes or status none with neither'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.favicons (host, content, content_32, content_type, status, fetched_at, expires_at)
  VALUES (p_host, p_content, p_content_32, 'image/png', p_status, v_now, v_now + interval '7 days')
  ON CONFLICT (host) DO UPDATE
  SET content = EXCLUDED.content, content_32 = EXCLUDED.content_32, content_type = EXCLUDED.content_type, status = EXCLUDED.status,
      fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at;
END
$$;

ALTER FUNCTION public.sys_favicon_get(text, integer) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_favicon_put(text, text, bytea, bytea) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_favicon_get(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_favicon_put(text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_favicon_get(text, integer) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_favicon_put(text, text, bytea, bytea) TO slugbase_app;

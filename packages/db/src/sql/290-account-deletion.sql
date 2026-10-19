-- The system operations behind deleting an account (doc 05 sections 3.3 and 7.1, doc 02 section 2.10, doc 10 T1).
-- Both are entered in src/system/registry.ts. slugbase_owner creates each function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those statements.
--
-- The account row is deleted by sys_delete_account only, and the events that name the account lose what names it
-- before the account is gone: the coarse network of the events it made, and the target identifier (entity_id) and
-- the `transferTo` metadata field of the events about it (doc 05 section 7.1). Those are the only columns of
-- audit_events slugbase_system may change.
GRANT DELETE ON TABLE public.accounts TO slugbase_system;
GRANT UPDATE (ip_prefix, entity_id, metadata) ON TABLE public.audit_events TO slugbase_system;

GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_account_deletion_scope(account_id): what deleting the account would do to each workspace it belongs to that is
-- not already being deleted, so the caller can refuse or ask the deletion guard before anything changes. A workspace
-- is `blocking` when the account is its only owner and it has other members (the account would leave it without an
-- owner), and `sole` when the account is its only member (it goes with the account). A workspace with another owner,
-- or one where the account is not an owner, is neither: the membership just ends. The rows of the workspaces and
-- then the account are locked first, in that order and the workspaces in identifier order, the order the member and
-- invitation paths take them in, so the answer stays true for the rest of the transaction: no member joins, leaves
-- or changes role in these workspaces and the account gains no membership until it commits. The account of the
-- transaction (app_account_id(), which must be the argument) is the only account that can ask; for any other
-- argument, and when no tenant account is set, nothing comes back and nothing is locked.
CREATE OR REPLACE FUNCTION public.sys_account_deletion_scope(p_account_id uuid)
  RETURNS TABLE (workspace_id uuid, workspace_name text, kind text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_account_deletion_scope needs an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS DISTINCT FROM p_account_id THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public.workspaces w
  WHERE w.deleting_at IS NULL
    AND w.id IN (SELECT m.workspace_id FROM public.workspace_members m WHERE m.account_id = p_account_id)
  ORDER BY w.id
  FOR UPDATE OF w;
  PERFORM 1 FROM public.accounts a WHERE a.id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT w.id, w.name,
    CASE
      WHEN c.members = 1 THEN 'sole'
      WHEN me.role = 'owner' AND c.other_owners = 0 THEN 'blocking'
    END
  FROM public.workspace_members me
  JOIN public.workspaces w ON w.id = me.workspace_id AND w.deleting_at IS NULL
  CROSS JOIN LATERAL (
    SELECT count(*) AS members, count(*) FILTER (WHERE o.role = 'owner' AND o.account_id <> p_account_id) AS other_owners
    FROM public.workspace_members o WHERE o.workspace_id = w.id
  ) c
  WHERE me.account_id = p_account_id
    AND (c.members = 1 OR (me.role = 'owner' AND c.other_owners = 0))
  ORDER BY w.id;
END
$$;

-- sys_account_last_instance_admin(account_id): whether the account holds the instance-admin flag and no other account
-- does, so deleting it would leave the instance without an admin (doc 02 section 6). It is the last step of the locks
-- of the deletion, after the workspaces and the account's own row (sys_account_deletion_scope): an account that is an
-- instance admin takes the transaction-level advisory lock of the set of admins, held until the transaction ends, and
-- reads the other admins under it. Two admins deleting themselves at once therefore take the decision one after the
-- other, and the second one sees the first one's deletion; neither reads "another admin remains" from the same stale
-- set. Row locks on the admins' rows would be taken in the order each caller reaches them and could deadlock two
-- admins; the one advisory key cannot, because it is always taken after the rows of the caller and never before them.
-- A path that clears the flag of an admin or deletes one must take the same key after the rows it locks, or it and a
-- deletion each read the other admin as still there; only the deletion and this function take it so far. The first
-- promotion of the first-run setup needs no lock, as no admin exists for it to race with. An account that is not an
-- admin takes no lock: its own row is locked by the scope, so its flag holds for the transaction. For an account other than the one of the transaction, and when no tenant account is set, it is false
-- and nothing is locked.
CREATE OR REPLACE FUNCTION public.sys_account_last_instance_admin(p_account_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'sys_account_last_instance_admin needs an account'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS DISTINCT FROM p_account_id THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p_account_id AND a.is_instance_admin) THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('slugbase.instance_admins'));
  RETURN NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.is_instance_admin AND a.id <> p_account_id);
END
$$;

-- sys_delete_account(account_id, sole_workspace_ids): deletes the account of the transaction, in that transaction, and
-- says whether it did. The workspaces where the account is the only member (`sole_workspace_ids`, the ones the
-- caller asked the deletion guard about) are put through the request half of the workspace deletion (doc 05 section
-- 7.2) as sys_workspace_mark_deleting does for one: deleting_at is set, the sessions that had them active are
-- pointed at none and their API tokens are revoked, and the caller queues the workspace.delete job of each in the
-- same transaction. The network prefix of every event that names the account as its actor is cleared, the target
-- identifier of every event that names it as its target is cleared and the `transferTo` metadata field that names
-- it is removed (the event keeps its type, label and other fields; `transferTo` is the only field of the audit
-- catalog that holds an account identifier), and the account row is deleted, which ends its memberships elsewhere (the owner rule does not apply to a workspace being
-- deleted) and deletes everything that cascades from it: sessions, API tokens, identities, credential tokens, backup
-- codes; the audit events stay with the actor reference set to NULL and the label they carry. The scope is
-- computed again under the locks of sys_account_deletion_scope: when the account is the only owner of a workspace
-- that has other members, or the workspaces where it is the only member are not exactly `sole_workspace_ids`, the
-- function is false and changes nothing, and so it is when the account is the last instance admin
-- (sys_account_last_instance_admin, read under its lock once the account is locked). It is false as well for an
-- account other than the one of the transaction, for a transaction that acts in a workspace and for an account that
-- does not exist; the caller cannot tell these apart.
CREATE OR REPLACE FUNCTION public.sys_delete_account(p_account_id uuid, p_sole_workspace_ids uuid[])
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_sole uuid[];
  v_blocking integer;
BEGIN
  IF p_account_id IS NULL OR p_sole_workspace_ids IS NULL THEN
    RAISE EXCEPTION 'sys_delete_account needs an account and the workspaces that go with it'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF public.app_account_id() IS DISTINCT FROM p_account_id OR public.app_workspace_id() IS NOT NULL THEN
    RETURN false;
  END IF;

  SELECT coalesce(array_agg(s.workspace_id ORDER BY s.workspace_id) FILTER (WHERE s.kind = 'sole'), '{}'),
         count(*) FILTER (WHERE s.kind = 'blocking')
  INTO v_sole, v_blocking
  FROM public.sys_account_deletion_scope(p_account_id) s;
  IF public.sys_account_last_instance_admin(p_account_id) THEN
    RETURN false;
  END IF;
  IF v_blocking > 0 OR v_sole IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT i ORDER BY i), '{}') FROM unnest(p_sole_workspace_ids) i) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p_account_id) THEN
    RETURN false;
  END IF;

  UPDATE public.workspaces SET deleting_at = v_now WHERE id = ANY (v_sole);
  UPDATE public.sessions SET active_workspace_id = NULL WHERE active_workspace_id = ANY (v_sole);
  UPDATE public.api_tokens SET revoked_at = v_now WHERE workspace_id = ANY (v_sole) AND revoked_at IS NULL;
  UPDATE public.audit_events SET ip_prefix = NULL WHERE actor_account_id = p_account_id AND ip_prefix IS NOT NULL;
  UPDATE public.audit_events SET entity_id = NULL WHERE entity_id = p_account_id;
  UPDATE public.audit_events SET metadata = metadata - 'transferTo' WHERE lower(metadata ->> 'transferTo') = p_account_id::text;
  DELETE FROM public.accounts WHERE id = p_account_id;
  RETURN true;
END
$$;

ALTER FUNCTION public.sys_account_deletion_scope(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_account_last_instance_admin(uuid) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_delete_account(uuid, uuid[]) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_account_deletion_scope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_account_last_instance_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_delete_account(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_account_deletion_scope(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_account_last_instance_admin(uuid) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_delete_account(uuid, uuid[]) TO slugbase_app;

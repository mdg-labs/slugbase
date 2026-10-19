-- The rule that a workspace always has an owner (doc 02 section 3.3, doc 05 section
-- 2.2, doc 10 T2). workspace_members_check_owner() is entered in
-- src/system/registry.ts. slugbase_owner creates the function and hands it to
-- slugbase_system, which needs CREATE on the schema for the length of those
-- statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- workspace_members_check_owner(): the trigger function behind the constraint
-- trigger below. It runs after a row of workspace_members that was an owner was
-- deleted or stopped being one in its workspace, when the transaction commits,
-- and refuses the commit (check_violation, constraint
-- workspace_members_owner_required) when the workspace then has no owner. A
-- workspace being deleted is exempt, and so is one the transaction itself
-- deleted, whose members go with it.
--
-- Two transactions that each remove a different owner of one workspace do not see
-- each other's change, so each would find the other still an owner. The function
-- therefore takes the lock of the workspace's row before it counts: the second
-- transaction waits until the first has committed, and the count that follows is
-- a statement of its own that reads what the first committed (the function is
-- VOLATILE and the transaction READ COMMITTED), so exactly one of the two
-- commits. It runs as slugbase_system so that it reads every member of the
-- workspace whatever the row-level security of the caller shows.
CREATE OR REPLACE FUNCTION public.workspace_members_check_owner() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF OLD.role <> 'owner' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' AND NEW.workspace_id = OLD.workspace_id THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM public.workspaces w
  WHERE w.id = OLD.workspace_id AND w.deleting_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id = OLD.workspace_id AND m.role = 'owner') THEN
    RAISE EXCEPTION 'the workspace would have no owner'
      USING ERRCODE = 'check_violation', TABLE = 'workspace_members', CONSTRAINT = 'workspace_members_owner_required';
  END IF;
  RETURN NULL;
END
$$;

ALTER FUNCTION public.workspace_members_check_owner() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.workspace_members_check_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workspace_members_check_owner() TO slugbase_app;

-- A constraint trigger has no CREATE OR REPLACE, and every migration that carries the
-- files of src/sql/ runs this one again, so it is dropped and created in the same
-- migration.
DROP TRIGGER IF EXISTS workspace_members_owner_required ON public.workspace_members;
CREATE CONSTRAINT TRIGGER workspace_members_owner_required
  AFTER DELETE OR UPDATE ON public.workspace_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.workspace_members_check_owner();

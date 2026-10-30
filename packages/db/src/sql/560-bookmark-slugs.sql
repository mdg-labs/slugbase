-- Slugs and forwarding of bookmarks (doc 05 sections 2.4 and 7.1, doc 02 sections 3.5 and 6.1, doc 10 T1, T2 and T12). The columns, the grammar CHECK
-- and the two slug indexes are defined in src/schema/bookmarks.ts; this file grants what the operations that set and clear a slug write and
-- keeps a departure from breaking the unique key.
--
-- slugbase_app may insert and update slug and forwarding. A slug is valid only in the grammar of the CHECK (lower case, so two spellings that differ
-- only in case cannot both be stored), forwarding needs a slug (CHECK bookmarks_forwarding_check), and a slug is unique per owner within the workspace
-- (bookmarks_owner_slug_key), so the database itself refuses a malformed slug, a forwarding bookmark without one and a second bookmark of the
-- owner with the same slug, whatever the application passed. The owner and the archive state stay out of reach of the role.
GRANT INSERT (slug, forwarding) ON TABLE public.bookmarks TO slugbase_app;
GRANT UPDATE (slug, forwarding) ON TABLE public.bookmarks TO slugbase_app;

-- What a member's bookmarks are when the membership ends. bookmarks.owner_id is cleared by the foreign key to workspace_members (ON DELETE SET NULL
-- (owner_id)), which moves the bookmarks of the departing member into the one namespace of the ownerless bookmarks of the workspace
-- (bookmarks_owner_slug_key is NULLS NOT DISTINCT), so a bookmark whose slug an ownerless bookmark already holds would break the key and with it the
-- deletion of the membership. Every statement that deletes a membership row (the removal of a member, a member leaving, the deletion of an account by
-- its owner or by an instance admin, the purge of a workspace) clears the owner by that foreign key, and the trigger below clears the slug of such a
-- bookmark in the same UPDATE and turns its forwarding off (forwarding needs a slug), so the rule has one place and a path that deletes the row
-- directly cannot skip it. The bookmark keeps its URL, its title, its filings and its other columns. bookmarks_clear_slug_on_release() is entered in
-- src/system/registry.ts. slugbase_owner creates the function and hands it to slugbase_system, which needs CREATE on the schema for the length of that
-- statement.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- bookmarks_clear_slug_on_release(): the trigger function. It runs before a row of bookmarks is updated, and acts when the update takes the owner away
-- (OLD.owner_id is set and NEW.owner_id is NULL) from a bookmark that has a slug: when an ownerless bookmark of the workspace has that slug, the
-- slug is cleared and forwarding becomes false. A bookmark whose slug no ownerless bookmark holds keeps it, and so does its forwarding. The version
-- moves with the owner (bookmarks_bump_version). The same update records the departure that released the bookmark, with or without a slug (departure_id,
-- from app_departure_id() of src/sql/680-member-departure.sql), which is null when the statement named none, so the worker can tell the bookmarks of one
-- departure from every other ownerless bookmark when it applies the content choice. When that departure's bookmark loses its slug, the slug and the forwarding it
-- had are kept in departure_slug and departure_forwarding, so a transfer to the recipient gives them back unless the recipient owns the slug.
--
-- The slugs of the ownerless bookmarks change only here, so two departures from one workspace that run at once would each read the ownerless
-- bookmarks without the other's release and both keep a slug the other keeps, and the second would meet the unique key. The function therefore takes
-- the lock of the workspace's row first (the lock the owner trigger, the role changes, the deletion of the workspace and the folders' release take),
-- and the second transaction waits until the first has committed: the statement that follows reads what it committed (the function is VOLATILE and
-- the transaction READ COMMITTED). A workspace row that the transaction deleted itself is not there to lock, and nothing then races for its
-- bookmarks. The function runs as slugbase_system so that it reads every bookmark of the workspace whatever the row-level security of the caller
-- shows, and the foreign key's own session needs no privilege on it; it reads the bookmarks of NEW.workspace_id only.
CREATE OR REPLACE FUNCTION public.bookmarks_clear_slug_on_release() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
BEGIN
  IF OLD.owner_id IS NULL OR NEW.owner_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  NEW.departure_id := public.app_departure_id();
  NEW.departure_slug := NULL;
  NEW.departure_forwarding := NULL;
  IF NEW.slug IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.workspaces w WHERE w.id = NEW.workspace_id FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.bookmarks g
    WHERE g.workspace_id = NEW.workspace_id AND g.owner_id IS NULL AND g.id <> NEW.id AND g.slug = NEW.slug) THEN
    IF NEW.departure_id IS NOT NULL THEN
      NEW.departure_slug := NEW.slug;
      NEW.departure_forwarding := NEW.forwarding;
    END IF;
    NEW.slug := NULL;
    NEW.forwarding := false;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.bookmarks_clear_slug_on_release() OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.bookmarks_clear_slug_on_release() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bookmarks_clear_slug_on_release() TO slugbase_app;

CREATE OR REPLACE TRIGGER bookmarks_release_slug
  BEFORE UPDATE ON public.bookmarks
  FOR EACH ROW EXECUTE FUNCTION public.bookmarks_clear_slug_on_release();

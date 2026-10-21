-- The instance settings and the test email of the CE instance admin (doc 05 sections 2.2, 2.9 and 3.3, doc 02
-- section 11.3, doc 04 section 10.10). The table is instance_settings (src/schema/instance.ts). It holds no personal
-- data and has no row-level security, because the display name and the sign-in notice are public on the sign-in page
-- and whether accounts may create workspaces is answered by the workspace list: slugbase_app reads it and nothing
-- else, and the row is written only by sys_instance_update_settings, which runs as slugbase_system. All three functions
-- are entered in src/system/registry.ts. slugbase_owner creates each function and hands it to slugbase_system, which
-- needs CREATE on the schema for the length of those statements.
GRANT CREATE ON SCHEMA public TO slugbase_system;

-- sys_instance_settings(event_id, ip_prefix): the settings as they are stored (every column NULL while no row exists),
-- and the instance audit event 'instance.settings_viewed' for the account of the transaction, in the same call, under
-- the check of sys_instance_status. Reading the settings as an instance admin is an action of the admin and is
-- audited like the status; the sign-in page and the workspace routes read the table directly and write no event.
CREATE OR REPLACE FUNCTION public.sys_instance_settings(p_event_id uuid, p_ip_prefix cidr)
  RETURNS TABLE (allow_workspace_creation boolean, display_name text, sign_in_notice text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_settings needs an event id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.settings_viewed', '{}'::jsonb, p_ip_prefix);

  RETURN QUERY SELECT
    (SELECT s.allow_workspace_creation FROM public.instance_settings s WHERE s.id = 1),
    (SELECT s.display_name FROM public.instance_settings s WHERE s.id = 1),
    (SELECT s.sign_in_notice FROM public.instance_settings s WHERE s.id = 1);
END
$$;

-- sys_instance_update_settings(...): changes the settings whose p_set_* flag is true, to the value that follows it
-- (NULL clears the setting, so the default of the deployment applies again), and leaves the others as they are. The
-- row is created by the first call. Like every sys_instance_* function it repeats the check of the instanceAdmin
-- policy inside its own body: the account of the transaction (app_account_id(), never an argument) must hold the
-- instance-admin flag, have a second factor enrolled and not be disabled, otherwise it raises insufficient_privilege
-- and writes nothing. The audit event 'instance.settings_changed' names the settings that changed, never a value,
-- and is written in the same call under the identifier the application generated (Q91). A call that changes no
-- setting raises invalid_parameter_value. Answers the row as it is after the change.
CREATE OR REPLACE FUNCTION public.sys_instance_update_settings(
  p_event_id uuid,
  p_ip_prefix cidr,
  p_set_allow_workspace_creation boolean,
  p_allow_workspace_creation boolean,
  p_set_display_name boolean,
  p_display_name text,
  p_set_sign_in_notice boolean,
  p_sign_in_notice text
) RETURNS TABLE (allow_workspace_creation boolean, display_name text, sign_in_notice text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF p_event_id IS NULL OR p_set_allow_workspace_creation IS NULL OR p_set_display_name IS NULL OR p_set_sign_in_notice IS NULL THEN
    RAISE EXCEPTION 'sys_instance_update_settings needs an event id and a flag for each setting' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_set_allow_workspace_creation THEN
    v_changed := array_append(v_changed, 'allowWorkspaceCreation'::text);
  END IF;
  IF p_set_display_name THEN
    v_changed := array_append(v_changed, 'displayName'::text);
  END IF;
  IF p_set_sign_in_notice THEN
    v_changed := array_append(v_changed, 'signInNotice'::text);
  END IF;
  IF cardinality(v_changed) = 0 THEN
    RAISE EXCEPTION 'sys_instance_update_settings was given no setting to change' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.instance_settings AS s (id, allow_workspace_creation, display_name, sign_in_notice, updated_by)
  VALUES (
    1,
    CASE WHEN p_set_allow_workspace_creation THEN p_allow_workspace_creation END,
    CASE WHEN p_set_display_name THEN p_display_name END,
    CASE WHEN p_set_sign_in_notice THEN p_sign_in_notice END,
    public.app_account_id()
  )
  ON CONFLICT (id) DO UPDATE SET
    allow_workspace_creation = CASE WHEN p_set_allow_workspace_creation THEN p_allow_workspace_creation ELSE s.allow_workspace_creation END,
    display_name = CASE WHEN p_set_display_name THEN p_display_name ELSE s.display_name END,
    sign_in_notice = CASE WHEN p_set_sign_in_notice THEN p_sign_in_notice ELSE s.sign_in_notice END,
    updated_by = public.app_account_id();

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (
    p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.settings_changed',
    jsonb_build_object('settings', array_to_string(v_changed, ',')), p_ip_prefix
  );

  RETURN QUERY
    SELECT s.allow_workspace_creation, s.display_name, s.sign_in_notice FROM public.instance_settings s WHERE s.id = 1;
END
$$;

-- sys_instance_test_mail(event_id, ip_prefix): the instance audit event 'instance.test_mail_queued' for the account of
-- the transaction, written under the check of sys_instance_update_settings, so the test email that the caller queues
-- in the same transaction exists exactly when its event does. It sends and queues nothing itself.
CREATE OR REPLACE FUNCTION public.sys_instance_test_mail(p_event_id uuid, p_ip_prefix cidr)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
DECLARE
  v_label text;
BEGIN
  IF p_event_id IS NULL THEN
    RAISE EXCEPTION 'sys_instance_test_mail needs an event id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.display_name INTO v_label
  FROM public.accounts a
  WHERE a.id = public.app_account_id() AND a.is_instance_admin AND a.mfa_enabled_at IS NOT NULL AND a.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the instance operations are for instance admins with a second factor' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_events (id, workspace_id, actor_type, actor_account_id, actor_label, action, metadata, ip_prefix)
  VALUES (p_event_id, NULL, 'account', public.app_account_id(), v_label, 'instance.test_mail_queued', '{}'::jsonb, p_ip_prefix);
END
$$;

ALTER FUNCTION public.sys_instance_settings(uuid, cidr) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_update_settings(uuid, cidr, boolean, boolean, boolean, text, boolean, text) OWNER TO slugbase_system;
ALTER FUNCTION public.sys_instance_test_mail(uuid, cidr) OWNER TO slugbase_system;
REVOKE CREATE ON SCHEMA public FROM slugbase_system;

REVOKE ALL ON FUNCTION public.sys_instance_settings(uuid, cidr) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_update_settings(uuid, cidr, boolean, boolean, boolean, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sys_instance_test_mail(uuid, cidr) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sys_instance_settings(uuid, cidr) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_update_settings(uuid, cidr, boolean, boolean, boolean, text, boolean, text) TO slugbase_app;
GRANT EXECUTE ON FUNCTION public.sys_instance_test_mail(uuid, cidr) TO slugbase_app;

-- instance_settings: no personal data and no row-level security. slugbase_app reads it, which is how the sign-in page
-- and the workspace routes see the settings; only sys_instance_update_settings writes it.
REVOKE ALL ON TABLE public.instance_settings FROM PUBLIC, slugbase_app;
GRANT SELECT ON TABLE public.instance_settings TO slugbase_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.instance_settings TO slugbase_system;

CREATE OR REPLACE TRIGGER instance_settings_set_updated_at
  BEFORE UPDATE ON public.instance_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

import { UNSET_INSTANCE_SETTINGS, type InstanceSettings } from "@slugbase/core";
import type postgres from "postgres";

// The instance settings of the sign-in page and the first `GET /api/config` of a visit (doc 05 section 2.2): they are
// public, `instance_settings` has no row-level security and `slugbase_app` may read it, so the anonymous pool of the
// auth store reads the row directly, outside any tenant transaction. Writing it is the instance admin's, through
// `sys_instance_update_settings` (src/repositories/instance.ts).

export interface InstanceSettingsStore {
  /** The instance settings; every one is null while none was ever saved. */
  instanceSettings(): Promise<InstanceSettings>;
}

interface SettingsRow {
  allow_workspace_creation: boolean | null;
  display_name: string | null;
  sign_in_notice: string | null;
}

/** Binds the settings store to a connection pool that connects as the application role. */
export function bindInstanceSettingsStore(client: postgres.Sql): InstanceSettingsStore {
  return {
    async instanceSettings() {
      const rows = await client<SettingsRow[]>`
        SELECT allow_workspace_creation, display_name, sign_in_notice FROM public.instance_settings WHERE id = 1`;
      const row = rows[0];
      return row === undefined
        ? UNSET_INSTANCE_SETTINGS
        : { allowWorkspaceCreation: row.allow_workspace_creation, displayName: row.display_name, signInNotice: row.sign_in_notice };
    },
  };
}

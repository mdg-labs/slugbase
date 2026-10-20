// The instance settings of doc 02 section 11.3: one row of typed values the instance admin edits. A setting that
// was never set, or was cleared, is `null` and the deployment's own default applies: for whether accounts may
// create workspaces that is the value the composition root supplies (doc 02 section 3.2), for the display name
// the product's name, and for the sign-in notice none. No edition decides any of it (D4).

/** The settings, by the names the API and the instance audit event use. */
export const INSTANCE_SETTING_NAMES = ["allowWorkspaceCreation", "displayName", "signInNotice"] as const;

export type InstanceSettingName = (typeof INSTANCE_SETTING_NAMES)[number];

/** What is stored: `null` is "not set". The notice is plain text and is shown as text only. */
export interface InstanceSettings {
  readonly allowWorkspaceCreation: boolean | null;
  readonly displayName: string | null;
  readonly signInNotice: string | null;
}

/** What an update changes: a key that is absent keeps its value and `null` clears it. */
export type InstanceSettingsChange = { readonly [Name in InstanceSettingName]?: InstanceSettings[Name] };

/** The settings of an instance that never saved any. */
export const UNSET_INSTANCE_SETTINGS: InstanceSettings = Object.freeze({ allowWorkspaceCreation: null, displayName: null, signInNotice: null });

/**
 * Whether the deployment lets ordinary accounts create workspaces: the stored setting when there is one, else the
 * default the composition supplies. It is read from the database by each request that decides, so a change applies
 * on the next one.
 */
export function workspaceCreationAllowed(settings: Pick<InstanceSettings, "allowWorkspaceCreation">, compositionDefault: boolean): boolean {
  return settings.allowWorkspaceCreation ?? compositionDefault;
}

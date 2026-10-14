/**
 * The named extension points of the shell (doc 03 "Extension slots"). The set is
 * closed and the names are a contract (doc 01 section 7.4): a rename or a removal
 * breaks the compositions that fill them.
 */
export const SLOT_NAMES = [
  "sidebar.workspacePlan",
  "sidebar.footer",
  "banner.entitlement",
  "entitlement.upgradeAction",
  "accountMenu.items",
  "settings.workspace.nav",
  "settings.workspace.members.seats",
  "dashboard.top",
  "auth.footer",
  "auth.register.footer",
] as const;

/** One of the ten slot names; any other string is a type error. */
export type SlotName = (typeof SLOT_NAMES)[number];

export function isSlotName(name: string): name is SlotName {
  return (SLOT_NAMES as readonly string[]).includes(name);
}

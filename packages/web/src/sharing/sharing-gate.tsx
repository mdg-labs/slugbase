import type { ReactElement, ReactNode } from "react";
import { EntitlementGate, useIsGranted } from "../entitlements/index.ts";

/**
 * Renders its children where the workspace holds `sharing.members` or `sharing.teams`, and otherwise what the
 * `entitlement-gate` renders for a missing entitlement: the `entitlement.upgradeAction` slot, which is empty where no extension fills it.
 */
export function SharingGate({ children }: { children: ReactNode }): ReactElement {
  const members = useIsGranted("sharing.members");
  return members ? <>{children}</> : <EntitlementGate name="sharing.teams">{children}</EntitlementGate>;
}

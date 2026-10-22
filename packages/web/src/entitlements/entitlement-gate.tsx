import type { ReactElement, ReactNode } from "react";
import { Slot } from "../extensions/index.ts";
import type { FeatureEntitlement } from "./entitlements.ts";
import { useIsGranted } from "./use-entitlements.ts";

/**
 * Renders its children where the workspace grants the entitlement `name`, and otherwise the `entitlement.upgradeAction`
 * slot, which renders nothing where no extension fills it (doc 03 `entitlement-gate`). While the entitlements
 * load, or when they cannot be loaded, the children render: the server refuses what is not granted.
 */
export function EntitlementGate({ name, children }: { name: FeatureEntitlement; children: ReactNode }): ReactElement | null {
  return useIsGranted(name) ? <>{children}</> : <Slot name="entitlement.upgradeAction" />;
}

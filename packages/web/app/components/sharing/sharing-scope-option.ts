import type { SharingScope, SharingScopeOption } from "./sharing.types.js";
import { SHARING_SCOPE_OPTIONS } from "./sharing.types.js";

const DEFAULT_SCOPE_OPTION: SharingScopeOption = {
  id: "all",
  labelKey: "sharing.scope.all",
  icon: "layers",
};

export function getSharingScopeOption(scope: SharingScope): SharingScopeOption {
  for (const option of SHARING_SCOPE_OPTIONS) {
    if (option.id === scope) {
      return option;
    }
  }
  return DEFAULT_SCOPE_OPTION;
}

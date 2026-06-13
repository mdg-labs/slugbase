import type {
  ShareResourceKind,
  SharingScope,
  SharingScopeOption,
} from "./sharing.types.js";
import { SHARING_SCOPE_OPTIONS } from "./sharing.types.js";

const ALL_SCOPE_LABEL_KEYS: Record<ShareResourceKind, string> = {
  bookmark: "sharing.scope.all",
  folder: "sharing.scope.all_folders",
};

const DEFAULT_SCOPE_OPTION: SharingScopeOption = {
  id: "all",
  labelKey: "sharing.scope.all",
  icon: "layers",
};

export function getSharingScopeOption(
  scope: SharingScope,
  resourceKind: ShareResourceKind = "bookmark",
): SharingScopeOption {
  for (const option of SHARING_SCOPE_OPTIONS) {
    if (option.id === scope) {
      if (option.id === "all") {
        return {
          ...option,
          labelKey: ALL_SCOPE_LABEL_KEYS[resourceKind],
        };
      }
      return option;
    }
  }
  return {
    ...DEFAULT_SCOPE_OPTION,
    labelKey: ALL_SCOPE_LABEL_KEYS[resourceKind],
  };
}

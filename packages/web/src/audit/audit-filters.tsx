import { AUDIT_EVENT_CATEGORIES } from "@slugbase/contracts";
import { MultiPick, Picker, type PickerOption } from "@slugbase/ui/patterns";
import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FilterChips, type FilterChip } from "../bookmarks/filter-chips.tsx";
import type { AllMembers } from "../teams/use-all-members.ts";
import { categoryLabel } from "./audit-labels.ts";
import { isAuditCategory, type AuditSearch, type AuditSearchControls } from "./audit-search.ts";

export interface AuditFiltersProps {
  readonly search: AuditSearch;
  readonly members: AllMembers;
  readonly controls: AuditSearchControls;
}

/**
 * The filter bar of the audit log (doc 03 section 11.9): the actor out of the workspace's members, and the groups of actions, kept in the address. An actor that is no
 * member (anyone who left, or whose account is deleted, still has events in the log) is a filter all the same and is named a former member once the whole member list says so.
 */
export function AuditFilters({ search, members, controls }: AuditFiltersProps): ReactElement {
  const { t } = useTranslation();
  const categoryOptions = useMemo<readonly PickerOption[]>(() => AUDIT_EVENT_CATEGORIES.map((category) => ({ value: category, label: categoryLabel(t, category) })), [t]);
  const actorOptions = members.members.map((member) => ({ value: member.accountId, label: member.displayName, description: member.email }));
  const known = search.actor === undefined ? undefined : members.members.find((member) => member.accountId === search.actor);

  const chips: FilterChip[] = [];
  if (search.actor !== undefined) {
    // Absence is concluded only from the whole list: while it loads, or when it failed, the member may be one of those not read.
    let label = t("audit.filters.actor.unknown");
    if (known !== undefined) {
      label = known.displayName;
    } else if (members.status === "ready") {
      label = t("audit.filters.actor.former");
    }
    chips.push({
      id: "actor",
      label,
      onRemove: () => {
        controls.update({ actor: undefined });
      },
    });
  }

  return (
    <div className="flex flex-col gap-3" role="group" aria-label={t("audit.filters.label")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Picker
          description={members.status === "failed" ? t("audit.filters.actor.unavailable") : undefined}
          disabled={members.status === "failed"}
          emptyLabel={t("audit.filters.actor.empty")}
          label={t("audit.filters.actor.label")}
          loadingLabel={members.status === "loading" ? t("audit.filters.actor.loading") : undefined}
          onValueChange={(actor) => {
            controls.update({ actor });
          }}
          options={actorOptions}
          placeholder={t("audit.filters.actor.placeholder")}
          value={known?.accountId}
        />
        <MultiPick
          emptyLabel={t("audit.filters.category.empty")}
          label={t("audit.filters.category.label")}
          onValueChange={(next) => {
            controls.update({ category: next.filter(isAuditCategory) });
          }}
          options={categoryOptions}
          placeholder={t("audit.filters.category.placeholder")}
          removeLabel={(label) => t("audit.filters.category.remove", { name: label })}
          value={search.category ?? []}
        />
      </div>
      <FilterChips chips={chips} />
    </div>
  );
}

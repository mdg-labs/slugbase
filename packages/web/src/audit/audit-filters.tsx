import { AUDIT_EVENT_CATEGORIES } from "@slugbase/contracts";
import { DateRange, MultiPick, Picker, type PickerOption } from "@slugbase/ui/patterns";
import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FilterChips, type FilterChip } from "../bookmarks/filter-chips.tsx";
import { useFormat } from "../i18n/use-format.ts";
import type { AllMembers } from "../teams/use-all-members.ts";
import { categoryLabel } from "./audit-labels.ts";
import { startOfDay } from "./audit-range.ts";
import { AUDIT_RANGE_PRESETS, isAuditCategory, type AuditRangePreset, type AuditSearch, type AuditSearchControls } from "./audit-search.ts";

const ANY = "any";
const CUSTOM = "custom";

export interface AuditFiltersProps {
  readonly search: AuditSearch;
  readonly members: AllMembers;
  readonly controls: AuditSearchControls;
  /** Whether the member chose a custom range, which the address holds only once it has a day. */
  readonly customRange: boolean;
  readonly onCustomRangeChange: (custom: boolean) => void;
  /** Whether the server refused the range as it stands. */
  readonly rangeRefused: boolean;
}

/**
 * The filter bar of the audit log (doc 03 section 11.9): the actor out of the workspace's members, the groups of actions and the date range, kept in the address. An actor that is no
 * member (anyone who left, or whose account is deleted, still has events in the log) is a filter all the same and is named a former member once the whole member list says so.
 */
export function AuditFilters({ search, members, controls, customRange, onCustomRangeChange, rangeRefused }: AuditFiltersProps): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const presetLabels = useMemo<Record<AuditRangePreset, string>>(
    () => ({
      "24h": t("audit.filters.range.24h"),
      "7d": t("audit.filters.range.7d"),
      "30d": t("audit.filters.range.30d"),
      "90d": t("audit.filters.range.90d"),
    }),
    [t],
  );
  const rangePresets = useMemo(
    () => [
      { value: ANY, label: t("audit.filters.range.any") },
      ...AUDIT_RANGE_PRESETS.map((preset) => ({ value: preset, label: presetLabels[preset] })),
      { value: CUSTOM, label: t("audit.filters.range.custom") },
    ],
    [t, presetLabels],
  );
  const hasDays = search.from !== undefined || search.to !== undefined;
  const rangeMode = search.range ?? (hasDays || customRange ? CUSTOM : ANY);
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

  if (search.range !== undefined) {
    chips.push({
      id: "range",
      label: presetLabels[search.range],
      onRemove: () => {
        controls.update({ range: undefined });
      },
    });
  } else if (hasDays) {
    const day = (value: string): string => format.date(startOfDay(value, 0), { dateStyle: "medium" });
    let label: string;
    if (search.from !== undefined && search.to !== undefined) {
      label = t("audit.filters.range.chip.between", { from: day(search.from), to: day(search.to) });
    } else if (search.from !== undefined) {
      label = t("audit.filters.range.chip.from", { from: day(search.from) });
    } else {
      label = t("audit.filters.range.chip.to", { to: day(search.to ?? "") });
    }
    chips.push({
      id: "range",
      label,
      onRemove: () => {
        onCustomRangeChange(false);
        controls.update({ from: undefined, to: undefined });
      },
    });
  }

  function choosePreset(preset: string): void {
    onCustomRangeChange(preset === CUSTOM);
    if (preset === CUSTOM) {
      // The days of an earlier custom range stay; a preset has none, so it is taken off.
      controls.update({ range: undefined });
    } else {
      controls.update({ range: AUDIT_RANGE_PRESETS.find((candidate): candidate is AuditRangePreset => candidate === preset), from: undefined, to: undefined });
    }
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
      <DateRange
        boundsError={t("audit.filters.range.boundsError")}
        customPreset={CUSTOM}
        days={{ first: search.from ?? "", last: search.to ?? "" }}
        error={rangeRefused ? t("audit.filters.range.refused") : undefined}
        firstLabel={t("audit.filters.range.first")}
        label={t("audit.filters.range.label")}
        lastLabel={t("audit.filters.range.last")}
        onDaysChange={({ first, last }) => {
          controls.update({ from: first === "" ? undefined : first, to: last === "" ? undefined : last });
        }}
        onPresetChange={choosePreset}
        orderError={t("audit.filters.range.orderError")}
        preset={rangeMode}
        presets={rangePresets}
      />
      <FilterChips chips={chips} />
    </div>
  );
}

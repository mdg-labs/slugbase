import { Button, Input } from "@slugbase/ui";
import { Banner, FormField, FormOverlay, SelectField, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAccountRefusalMessage, useRefreshAfterRefusal } from "./admin-account-dialogs.tsx";
import { ADMIN_ACCOUNTS_QUERY_KEY, setInstanceAccountAccessMode, type AccountRefusal, type InstanceAccount } from "./admin-accounts.ts";

const END_ACTIONS = ["disable", "delete"] as const;
type EndAction = (typeof END_ACTIONS)[number];
const [DISABLE, DELETE] = END_ACTIONS;

/** The date as an input of type date holds it: year, month and day of the local calendar. */
function dayOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/** The server needs the end of the period a day ahead; the extra minutes keep a request in flight from landing under it. */
const MINIMUM_AHEAD_MS = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;

/**
 * The first day an export-only period can end on: the first day whose end, in the admin's time zone, is at least a day ahead as the server
 * requires. That is tomorrow, unless it is the last minutes of today or tomorrow is a shorter day.
 */
export function earliestDay(now: Date): string {
  const candidate = new Date(now);
  candidate.setDate(candidate.getDate() + 1);
  while (new Date(`${dayOf(candidate)}T23:59:00`).getTime() - now.getTime() < MINIMUM_AHEAD_MS) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return dayOf(candidate);
}

/** The instant the chosen day ends, as the server takes it. */
function endOfDay(day: string): string | undefined {
  const at = new Date(`${day}T23:59:00`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * Leaves an account a fixed period in which it can sign in, read and export its data and nothing else (doc 03 section 12, doc 02 section 2.11,
 * `form-overlay`): the day the period ends and what happens then, the account being disabled or deleted. The call needs a fresh
 * re-authentication, which the shared prompt asks for. A refusal is explained in the dialog, which stays open; an account that is gone closes it.
 */
export function AccessModeDialog({ account, onClose }: { account: InstanceAccount; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const refusalMessage = useAccountRefusalMessage();
  const refreshAfter = useRefreshAfterRefusal();
  const [day, setDay] = useState("");
  const [endAction, setEndAction] = useState<EndAction>(DISABLE);
  const [missing, setMissing] = useState(false);
  const [refusal, setRefusal] = useState<AccountRefusal | undefined>(undefined);
  const name = account.displayName;

  const run = useMutation({
    mutationKey: ["admin", "accounts", "exportOnly"],
    mutationFn: (until: string) => setInstanceAccountAccessMode(api, account.id, { mode: "exportOnly", until, endAction }),
    onSuccess: (outcome) => {
      if (outcome.status === "refused") {
        refreshAfter(outcome.refusal);
        if (outcome.refusal.kind === "gone") {
          feedbackToast.error(t("admin.accounts.error.title"), refusalMessage(outcome.refusal));
          onClose();
          return;
        }
        setRefusal(outcome.refusal);
        return;
      }
      feedbackToast.success(t("admin.accounts.action.exportOnly.done", { name }));
      void queryClient.invalidateQueries({ queryKey: ADMIN_ACCOUNTS_QUERY_KEY });
      onClose();
    },
  });

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (run.isPending) {
      return;
    }
    const until = endOfDay(day);
    if (until === undefined) {
      setMissing(true);
      return;
    }
    setMissing(false);
    setRefusal(undefined);
    run.mutate(until);
  }

  const dayError = missing ? t("admin.accounts.action.exportOnly.day.required") : refusal?.kind === "untilTooSoon" ? refusalMessage(refusal) : undefined;
  const banner = refusal !== undefined && refusal.kind !== "untilTooSoon" ? refusalMessage(refusal) : undefined;

  return (
    <FormOverlay
      closeLabel={t("admin.accounts.action.exportOnly.close")}
      description={t("admin.accounts.action.exportOnly.description", { name })}
      onOpenChange={(open) => {
        if (!open && !run.isPending) {
          onClose();
        }
      }}
      open
      title={t("admin.accounts.action.exportOnly.title", { name })}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {banner === undefined ? null : <Banner title={banner} variant="error" />}
        <FormField description={t("admin.accounts.action.exportOnly.day.description")} error={dayError} label={t("admin.accounts.action.exportOnly.day.label")} name="day">
          <Input
            disabled={run.isPending}
            min={earliestDay(new Date())}
            onChange={(event) => {
              setDay(event.target.value);
              setMissing(false);
              setRefusal(undefined);
            }}
            type="date"
            value={day}
          />
        </FormField>
        <SelectField
          description={t("admin.accounts.action.exportOnly.endAction.description")}
          disabled={run.isPending}
          label={t("admin.accounts.action.exportOnly.endAction.label")}
          name="endAction"
          onValueChange={(next) => {
            setEndAction(END_ACTIONS.find((candidate) => candidate === next) ?? DISABLE);
          }}
          options={[
            { value: DISABLE, label: t("admin.accounts.action.exportOnly.endAction.disable") },
            { value: DELETE, label: t("admin.accounts.action.exportOnly.endAction.delete") },
          ]}
          value={endAction}
        />
        <div className="flex justify-end gap-2">
          <Button disabled={run.isPending} onClick={onClose} type="button" variant="outline">
            {t("admin.accounts.cancel")}
          </Button>
          <Button loading={run.isPending} type="submit">
            {t("admin.accounts.action.exportOnly.label")}
          </Button>
        </div>
      </form>
    </FormOverlay>
  );
}

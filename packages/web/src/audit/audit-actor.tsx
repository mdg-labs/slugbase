import { AccountAvatar } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AuditEvent } from "./audit.ts";

/** The actor with the name it had at the time, and what it was when that is not an account that still exists. */
export function EventActor({ actor }: { actor: AuditEvent["actor"] }): ReactElement {
  const { t } = useTranslation();
  let note: string | undefined;
  if (actor.type === "system") {
    note = t("audit.actor.system");
  } else if (actor.type === "api_token") {
    note = t("audit.actor.apiToken");
  } else if (actor.accountId === null) {
    note = t("audit.actor.deleted");
  }
  return (
    <span className="flex items-center gap-2">
      <AccountAvatar name={actor.label} seed={actor.accountId ?? `${actor.type}:${actor.label}`} />
      <span className="flex min-w-0 flex-col">
        <span className="break-words font-medium">{actor.label}</span>
        {note === undefined ? null : <span className="text-muted-foreground text-xs">{note}</span>}
      </span>
    </span>
  );
}

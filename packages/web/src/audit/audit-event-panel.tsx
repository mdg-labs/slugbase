import { CopyValue, SidePanel, StatusBadge } from "@slugbase/ui/patterns";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { EventActor } from "./audit-actor.tsx";
import { actionLabel, categoryLabel, entityLabel, metadataLabel } from "./audit-labels.ts";
import type { AuditEvent } from "./audit.ts";

function Field({ term, children }: { term: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground text-xs">{term}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

/**
 * Everything one event holds (doc 03 section 11.9), beside the table: when, who, what, the target and the metadata. All of it is text, never markup and never a link to the thing it names
 * (T14, T11): an administrator has no implicit access to a member's content.
 */
export function AuditEventPanel({ event, open, onOpenChange }: { event: AuditEvent; open: boolean; onOpenChange: (open: boolean) => void }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const when = new Date(event.createdAt);
  const absolute = format.date(when, { dateStyle: "medium", timeStyle: "long" });
  const metadata = Object.entries(event.metadata);
  return (
    <SidePanel closeLabel={t("audit.panel.close")} description={t("audit.panel.description")} onOpenChange={onOpenChange} open={open} title={actionLabel(t, event.action)}>
      <dl className="flex flex-col gap-4">
        <Field term={t("audit.panel.time")}>
          <time dateTime={event.createdAt}>{absolute}</time>
        </Field>
        <Field term={t("audit.panel.actor")}>
          <EventActor actor={event.actor} />
        </Field>
        <Field term={t("audit.panel.action")}>{actionLabel(t, event.action)}</Field>
        <Field term={t("audit.panel.category")}>
          {event.category === null ? (
            <StatusBadge variant="neutral">{t("audit.categories.other")}</StatusBadge>
          ) : (
            <StatusBadge variant="info">{categoryLabel(t, event.category)}</StatusBadge>
          )}
        </Field>
        <Field term={t("audit.panel.target")}>
          {event.entity === null ? (
            <span className="text-muted-foreground">{t("audit.target.none")}</span>
          ) : (
            <span className="flex flex-col gap-2">
              <span>{entityLabel(t, event.entity.type)}</span>
              <CopyValue copiedLabel={t("audit.panel.copied")} copyLabel={t("audit.panel.copyId")} label={t("audit.panel.entityId")} value={event.entity.id} />
            </span>
          )}
        </Field>
      </dl>
      <section aria-labelledby="audit-panel-metadata" className="mt-6 flex flex-col gap-3">
        <h3 className="font-medium text-sm" id="audit-panel-metadata">
          {t("audit.panel.metadata")}
        </h3>
        {metadata.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("audit.panel.noMetadata")}</p>
        ) : (
          <dl className="flex flex-col gap-3">
            {metadata.map(([key, value]) => (
              <Field key={key} term={metadataLabel(t, key)}>
                {value}
              </Field>
            ))}
          </dl>
        )}
      </section>
    </SidePanel>
  );
}

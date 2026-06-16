import { useTranslation } from "react-i18next";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@slugbase/ui";
import { UsersIcon } from "lucide-react";
import { useState } from "react";

import {
  collectRecipientNames,
  computeEffectiveShareCount,
  getAccessPathMessageKey,
  getAccessPathMessageParams,
  isBookmarkSharingSummary,
  shouldShowRecipientsBadge,
  truncateRecipientNamesForTooltip,
  type SharingSummary,
} from "./sharing-recipients.utils.js";

export type SharingRecipientsBadgeProps = {
  summary: SharingSummary;
};

function RecipientListItem({ name }: { name: string }) {
  return (
    <li className="flex items-center gap-sp-2 py-sp-1 text-small text-fg">
      <UsersIcon aria-hidden size={12} className="shrink-0 text-fg-muted" />
      <span>{name}</span>
    </li>
  );
}

export function SharingRecipientsBadge({ summary }: SharingRecipientsBadgeProps) {
  const { t } = useTranslation();
  const [popoverOpen, setPopoverOpen] = useState(false);

  if (!shouldShowRecipientsBadge(summary)) {
    return null;
  }

  const isRecipientView = summary.scope === "shared-with-me";
  const shareCount = computeEffectiveShareCount(summary);
  const badgeLabel = isRecipientView
    ? t("sharing.label.shared_with_you")
    : t("sharing.label.shared_with_count", { count: shareCount });
  const ariaLabel = isRecipientView
    ? t("sharing.recipients.badge_aria_shared_with_you")
    : t("sharing.recipients.badge_aria_shared_with_count", { count: shareCount });

  const badgeToneClasses = isRecipientView
    ? "bg-[color:var(--warning-subtle)] text-[color:var(--warning-text)]"
    : "bg-[color:var(--accent-subtle)] text-accent-text";

  const recipientNames = collectRecipientNames(summary);
  const { visible: tooltipNames, overflowCount } =
    truncateRecipientNamesForTooltip(recipientNames);

  const tooltipContent = isRecipientView
    ? summary.accessPath
      ? t(
          getAccessPathMessageKey(summary.accessPath),
          getAccessPathMessageParams(summary.accessPath),
        )
      : badgeLabel
    : [
        tooltipNames.join(", "),
        overflowCount > 0
          ? t("sharing.recipients.tooltip_overflow", { count: overflowCount })
          : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <TooltipProvider delayDuration={200}>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={`inline-flex items-center gap-sp-2 rounded-sm px-sp-3 py-sp-1 text-small font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${badgeToneClasses}`}
                aria-label={ariaLabel}
                data-testid="sharing-recipients-badge"
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setPopoverOpen(true);
                  }
                }}
              >
                <UsersIcon aria-hidden size={12} className="shrink-0" />
                {badgeLabel}
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent testId="sharing-recipients-tooltip">
            {tooltipContent}
          </TooltipContent>
        </Tooltip>

        <PopoverContent testId="sharing-recipients-popover">
          <p
            className="mb-sp-3 text-small font-semibold text-fg"
            id="sharing-recipients-popover-title"
          >
            {t("sharing.recipients.popover_title")}
          </p>

          {isRecipientView ? (
            summary.accessPath ? (
              <p className="text-small text-fg-muted">
                {t(
                  getAccessPathMessageKey(summary.accessPath),
                  getAccessPathMessageParams(summary.accessPath),
                )}
              </p>
            ) : null
          ) : (
            <div className="flex flex-col gap-sp-4">
              {summary.directRecipients.length > 0 ? (
                <section aria-labelledby="sharing-recipients-direct-heading">
                  <h4
                    id="sharing-recipients-direct-heading"
                    className="mb-sp-2 text-micro font-semibold uppercase tracking-wide text-fg-muted"
                  >
                    {t("sharing.recipients.section_direct")}
                  </h4>
                  <ul className="list-none">
                    {summary.directRecipients.map((recipient) => (
                      <RecipientListItem
                        key={`${recipient.kind}-${recipient.targetId}`}
                        name={recipient.targetName}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {isBookmarkSharingSummary(summary)
                ? summary.viaFolders.map((folderShare) => (
                    <section
                      key={folderShare.folderId}
                      aria-labelledby={`sharing-recipients-folder-${folderShare.folderId}`}
                    >
                      <h4
                        id={`sharing-recipients-folder-${folderShare.folderId}`}
                        className="mb-sp-2 text-micro font-semibold uppercase tracking-wide text-fg-muted"
                      >
                        {t("sharing.recipients.section_via_folder", {
                          folderName: folderShare.folderName,
                        })}
                      </h4>
                      <ul className="list-none">
                        {folderShare.recipients.map((recipient) => (
                          <RecipientListItem
                            key={`${folderShare.folderId}-${recipient.kind}-${recipient.targetId}`}
                            name={recipient.targetName}
                          />
                        ))}
                      </ul>
                    </section>
                  ))
                : null}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

import { Badge, Button, Skeleton, Tooltip, TooltipPopup, TooltipTrigger } from "@slugbase/ui";
import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Slot } from "../extensions/index.ts";
import type { AiAvailability } from "./ai-suggest.ts";

export interface SuggestActionProps {
  availability: AiAvailability;
  /** Whether the API refused the action since the form opened. */
  refused: boolean;
  running: boolean;
  failed: boolean;
  onSuggest: () => void;
}

/** Whether the header has anything to show: the action, the room held for it, the upgrade slot or the note. */
export function suggestActionShown({ availability, refused, failed }: Pick<SuggestActionProps, "availability" | "refused" | "failed">): boolean {
  return (availability.kind === "ready" && !refused) || availability.kind === "pending" || availability.kind === "upgrade" || failed;
}

/**
 * The Suggest action in the header of the bookmark modal (doc 03 section 4) and the small note that says a request ended without a suggestion.
 * Where the action is not available there is no control at all, not a disabled one; the plan's upgrade slot stands in its place where the
 * workspace lacks the entitlement. The tooltip names the provider the operator configured, as it is the one that processes the request.
 * While it is not yet known whether the action is offered the row holds the height the action takes, so the fields below do not move when it
 * appears. Renders nothing when there is nothing to show. A press while a request runs keeps focus on the button: the `loading` state of `Button` is `aria-disabled`,
 * not `disabled`, so a keyboard member stays in the modal and the answer.
 */
export function SuggestAction({ availability, refused, running, failed, onSuggest }: SuggestActionProps): ReactElement | null {
  const { t } = useTranslation();
  if (!suggestActionShown({ availability, refused, failed })) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {availability.kind === "pending" ? <div aria-hidden="true" className="h-8 sm:h-7" data-slot="suggest-action-pending" /> : null}
      {availability.kind === "ready" && !refused ? (
        <Tooltip>
          <TooltipTrigger render={<Button loading={running} onClick={onSuggest} size="sm" variant="outline" />}>{t("bookmarks.modal.suggest.label")}</TooltipTrigger>
          <TooltipPopup>
            {availability.provider === undefined
              ? t("bookmarks.modal.suggest.tooltip.unnamed")
              : t("bookmarks.modal.suggest.tooltip.named", { provider: availability.provider })}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {availability.kind === "upgrade" ? <Slot name="entitlement.upgradeAction" /> : null}
      {failed ? (
        <span className="text-muted-foreground text-xs" role="status">
          {t("bookmarks.modal.suggest.unavailable")}
        </span>
      ) : null}
    </div>
  );
}

/** A field that shows a skeleton shimmer over itself while `active`, and stays usable beneath it: what the member types shows at once. */
export function ShimmerOver({ active, children }: { active: boolean; children: ReactNode }): ReactElement {
  return (
    <div className="relative">
      {children}
      {active ? <Skeleton aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-lg" /> : null}
    </div>
  );
}

export interface SuggestionChipsProps {
  /** Names the group for assistive technology, such as "Suggested title". */
  label: string;
  /** The suggestions on offer, rendered as text. */
  items: readonly string[];
  /** Whether the suggestion for the field is still on its way. */
  pending: boolean;
  onAccept: (item: string) => void;
  /**
   * Where focus goes when the last chip has been taken: the field the chips were for. A chip that holds focus when it is taken leaves the page,
   * and in some browsers focus then falls to the page behind the dialog, so it moves to the next chip, or here, instead.
   */
  fieldToFocus: () => HTMLElement | null;
}

/** Suggestions for a field the member has a value in, as selectable chips (Badges rendered as buttons) (doc 03 section 4): choosing one takes it and the chip goes. */
export function SuggestionChips({ label, items, pending, onAccept, fieldToFocus }: SuggestionChipsProps): ReactElement | null {
  const group = useRef<HTMLDivElement>(null);
  const taken = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const at = taken.current;
    if (at === undefined) {
      return;
    }
    taken.current = undefined;
    // The chip that now stands where the taken one stood, else the one before it, else the field.
    const buttons = group.current?.querySelectorAll<HTMLElement>("button") ?? [];
    (buttons[Math.min(at, buttons.length - 1)] ?? fieldToFocus())?.focus();
  });
  if (items.length === 0 && !pending) {
    return null;
  }
  return (
    <div aria-label={label} className="flex flex-wrap gap-1.5" ref={group} role="group">
      {pending ? <Skeleton aria-hidden="true" className="h-6 w-40 rounded-md" /> : null}
      {items.map((item, index) => (
        <Badge
          className="max-w-full"
          key={item}
          onClick={() => {
            taken.current = index;
            onAccept(item);
          }}
          render={<button type="button" />}
          size="lg"
          variant="outline"
        >
          <span className="truncate">{item}</span>
        </Badge>
      ))}
    </div>
  );
}

import { Button } from "@slugbase/ui";
import { useTranslation } from "react-i18next";

export type BookmarkModalAiSuggestionProps = {
  fieldLabel: string;
  value: string;
  onApply: () => void;
};

export function BookmarkModalAiSuggestion({
  fieldLabel,
  value,
  onApply,
}: BookmarkModalAiSuggestionProps) {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-wrap items-center gap-sp-3 rounded-md border border-dashed border-[color:var(--border-subtle)] bg-raised-2 px-sp-3 py-sp-2"
      data-testid="bookmark-modal-ai-suggestion"
    >
      <span
        className="text-fg-muted"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {t("bookmark.modal.ai.suggestion_label", { field: fieldLabel })}
      </span>
      <span
        className="min-w-0 flex-1 truncate font-medium text-fg"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {value}
      </span>
      <Button type="button" variant="secondary" onClick={onApply}>
        {t("bookmark.modal.ai.apply")}
      </Button>
    </div>
  );
}

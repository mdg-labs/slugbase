import { Button } from "@slugbase/ui";
import { useTranslation } from "react-i18next";

import type { BookmarkModalTagOption } from "../bookmark-modal.types.js";

export type BookmarkModalAiTagSuggestionsProps = {
  suggestedNames: string[];
  tags: BookmarkModalTagOption[];
  selectedTagIds: string[];
  onToggleTag: (tagId: string) => void;
};

function normalizeTagName(name: string): string {
  return name.trim().toLowerCase();
}

export function BookmarkModalAiTagSuggestions({
  suggestedNames,
  tags,
  selectedTagIds,
  onToggleTag,
}: BookmarkModalAiTagSuggestionsProps) {
  const { t } = useTranslation();

  const matches = suggestedNames
    .map((name) => {
      const normalized = normalizeTagName(name);
      const tag = tags.find((item) => normalizeTagName(item.name) === normalized);
      return tag ? { name, tag } : null;
    })
    .filter((item): item is { name: string; tag: BookmarkModalTagOption } => item != null);

  if (matches.length === 0) {
    return null;
  }

  return (
    <div
      className="flex flex-col gap-sp-2"
      data-testid="bookmark-modal-ai-tag-suggestions"
    >
      <p
        className="text-fg-muted"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {t("bookmark.modal.ai.tags_hint")}
      </p>
      <div className="flex flex-wrap gap-sp-2">
        {matches.map(({ tag }) => {
          const selected = selectedTagIds.includes(tag.id);
          return (
            <Button
              key={tag.id}
              type="button"
              variant={selected ? "primary" : "secondary"}
              aria-pressed={selected}
              onClick={() => {
                onToggleTag(tag.id);
              }}
            >
              {tag.name}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

import { Button } from "@slugbase/ui";
import { EmptyState, InboxIcon, PlusIcon } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useBookmarkModal } from "./modal-search.ts";
import { usePasteToCreate } from "./use-paste-to-create.ts";

/**
 * `/bookmarks`. It hosts the bookmark modal (which the shell renders over every page) and turns an address pasted onto
 * the page into a new bookmark; the list of bookmarks arrives with its own item.
 */
export function BookmarksPage(): ReactElement {
  const { t } = useTranslation();
  const modal = useBookmarkModal();
  usePasteToCreate(modal.openNew);
  return (
    <EmptyState
      actions={
        <Button
          onClick={() => {
            modal.openNew();
          }}
        >
          <PlusIcon aria-hidden="true" />
          {t("bookmarks.new")}
        </Button>
      }
      description={t("bookmarks.page.description")}
      headingLevel={1}
      icon={<InboxIcon aria-hidden="true" />}
      title={t("bookmarks.page.title")}
    />
  );
}

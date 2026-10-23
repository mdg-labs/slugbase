import { Button } from "@slugbase/ui";
import { PlusIcon } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "../account/me.ts";
import { useBookmarkModal } from "./modal-search.ts";

/**
 * The New bookmark button of the top bar (doc 03 "App shell"): it opens the bookmark modal over the current page. An
 * account that acts in no workspace has none to save to, so it has no button.
 */
export function NewBookmarkButton(): ReactElement | null {
  const { t } = useTranslation();
  const router = useRouter();
  const modal = useBookmarkModal();
  const me = useQuery({ ...meQuery(router.options.context.api), staleTime: Number.POSITIVE_INFINITY });
  if (me.data?.activeWorkspaceId === null) {
    return null;
  }
  return (
    <Button
      onClick={() => {
        modal.openNew();
      }}
      size="sm"
    >
      <PlusIcon aria-hidden="true" />
      <span className="max-sm:sr-only">{t("bookmarks.new")}</span>
    </Button>
  );
}

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRevalidator } from "react-router";
import { ConfirmDialog } from "@slugbase/ui";

import { useBookmarkModal } from "../bookmark-modal/BookmarkModalProvider.js";
import { useAppToast } from "../feedback/AppToastProvider.js";
import { navigateToExternalUrl } from "../../lib/safe-external-url.js";
import {
  deleteBookmark,
  toggleBookmarkPin,
} from "../../routes/bookmarks/bookmarks-api.js";
import type { BookmarkListItem } from "../../routes/bookmarks/bookmarks-loader.js";
import { useAppShellData } from "../../lib/session-client.js";

export type UseBookmarkCardActionsOptions = {
  onAfterMutation?: () => void;
};

export function useBookmarkCardActions(
  options?: UseBookmarkCardActionsOptions,
) {
  const { t } = useTranslation();
  const { showError, showToast } = useAppToast();
  const { openEdit } = useBookmarkModal();
  const revalidator = useRevalidator();
  const { user } = useAppShellData();
  const [deleteTarget, setDeleteTarget] = useState<BookmarkListItem | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handleOpenBookmark = useCallback(
    (bookmark: BookmarkListItem) => {
      if (bookmark.slug && bookmark.forwardingEnabled) {
        window.open(`/go/${bookmark.slug}`, "_blank", "noopener,noreferrer");
        return;
      }
      navigateToExternalUrl(bookmark.url, {
        newTab: true,
        onInvalid: () => {
          showError(t("bookmarks.navigation.unsafe_url"));
        },
      });
    },
    [showError, t],
  );

  const handlePin = useCallback(
    async (id: string, pinned: boolean) => {
      try {
        await toggleBookmarkPin(id, pinned);
        void revalidator.revalidate();
        options?.onAfterMutation?.();
      } catch {
        // ignore — toast system optional at this scope
      }
    },
    [options, revalidator],
  );

  const handleEdit = useCallback(
    (item: BookmarkListItem) => {
      openEdit({
        id: item.id,
        title: item.title,
        url: item.url,
        slug: item.slug,
        forwardingEnabled: item.forwardingEnabled,
        pinned: item.pinned,
        folderIds: item.folders.map((folder) => folder.id),
        tagIds: item.tags.map((tag) => tag.id),
      });
    },
    [openEdit],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await deleteBookmark(deleteTarget.id);
      setDeleteTarget(null);
      showToast("bookmarks.list.toast_deleted");
      void revalidator.revalidate();
      options?.onAfterMutation?.();
    } catch {
      showError(t("bookmarks.list.error_delete"));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, options, revalidator, showError, showToast, t]);

  const deleteDialog = (
    <ConfirmDialog
      open={deleteTarget !== null}
      onOpenChange={(open) => {
        if (!open) setDeleteTarget(null);
      }}
      title={t("bookmarks.list.delete_title")}
      description={
        deleteTarget
          ? t("bookmarks.list.delete_body", { title: deleteTarget.title })
          : undefined
      }
      confirmLabel={t("bookmarks.list.delete_confirm")}
      cancelLabel={t("bookmarks.list.delete_cancel")}
      onConfirm={() => {
        void handleDeleteConfirm();
      }}
      destructive
      busy={deleteBusy}
      testId="bookmark-delete-confirm-dialog"
    />
  );

  return {
    currentUserId: user.id,
    deleteDialog,
    handleOpenBookmark,
    handlePin,
    handleEdit,
    setDeleteTarget,
  };
}

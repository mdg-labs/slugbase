import { AccountAvatar, StatusBadge } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { Bookmark } from "./bookmarks.ts";

/**
 * The marker of a bookmark that is shared with the member (doc 03 section 3.2, doc 02 section 8.3): a "Shared" badge and the
 * owner's avatar and name, or "Former member" for a bookmark whose owner has left the workspace. The name is shown as text,
 * whatever it holds.
 */
export function SharedMarker({ bookmark }: { readonly bookmark: Bookmark }): ReactElement {
  const { t } = useTranslation();
  const owner = bookmark.owner ?? null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      <StatusBadge variant="info">{t("bookmarks.list.shared.marker")}</StatusBadge>
      {owner === null ? (
        <span>{t("bookmarks.list.shared.formerMember")}</span>
      ) : (
        <>
          <AccountAvatar name={owner.displayName} seed={owner.accountId} />
          <span className="max-w-32 truncate" translate="no">
            {owner.displayName}
          </span>
        </>
      )}
    </span>
  );
}

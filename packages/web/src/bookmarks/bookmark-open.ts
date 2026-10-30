import { feedbackToast } from "@slugbase/ui/patterns";
import type { ApiClient } from "../api/client.ts";
import { isHttpUrl, recordOpen, type Bookmark } from "./bookmarks.ts";

/** Opens the bookmark's address in a new tab and counts the open, as the card's link does; an address that is not `http` or `https` is not opened (T14). */
export function openInNewTab(api: ApiClient, bookmark: Bookmark): boolean {
  if (!isHttpUrl(bookmark.url)) {
    return false;
  }
  recordOpen(api, bookmark.id);
  window.open(bookmark.url, "_blank", "noopener,noreferrer");
  return true;
}

/** Copies the bookmark's address to the clipboard and says so; where the clipboard refuses it, says that instead. */
export async function copyAddress(bookmark: Bookmark, messages: { readonly copied: string; readonly failed: string }): Promise<void> {
  try {
    await globalThis.navigator.clipboard.writeText(bookmark.url);
  } catch {
    feedbackToast.error(messages.failed);
    return;
  }
  feedbackToast.success(messages.copied);
}

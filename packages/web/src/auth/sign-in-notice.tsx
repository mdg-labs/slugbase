import { InlineNote } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useConfig } from "../config/config-context.tsx";

/**
 * The notice the instance admin set for the sign-in page (doc 02 section 11.3, doc 10 T14). It is plain text the
 * server stored as typed, so it is rendered as a text node and never as markup: React escapes it, and line breaks
 * are kept by the style rather than by turning them into elements.
 */
export function SignInNotice(): ReactElement | null {
  const notice = useConfig().instance?.signInNotice;
  if (notice === undefined || notice === null || notice.trim() === "") {
    return null;
  }
  return (
    <InlineNote>
      <span className="whitespace-pre-line">{notice}</span>
    </InlineNote>
  );
}

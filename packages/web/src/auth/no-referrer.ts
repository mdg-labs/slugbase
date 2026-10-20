import { useEffect } from "react";

/**
 * While the page is mounted, the document sends no `Referer` with any navigation it starts. The address of an
 * invitation page holds its token, and a link on the page, the footer's included, must not hand it on.
 */
export function useNoReferrer(): void {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.append(meta);
    return () => {
      meta.remove();
    };
  }, []);
}

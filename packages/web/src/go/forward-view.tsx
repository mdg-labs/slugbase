import { Button } from "@slugbase/ui";
import { Banner, Loading } from "@slugbase/ui/patterns";
import { useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { GoCandidate } from "./go.ts";
import { useGoChoose } from "./use-go-choose.ts";

export interface ForwardViewProps {
  readonly slug: string;
  /** The one bookmark the slug goes to: the remembered choice, or the only candidate. */
  readonly bookmark: GoCandidate;
  /** Reads the slug again, which starts the view over. */
  readonly onRetry: () => void;
}

/**
 * A slug with one answer (doc 02 section 6.2): the page asks for the destination of the bookmark, which counts the use, and leaves
 * for it. The server forwards such a slug itself; this is for the page reached some other way, such as the address kept by a tab.
 */
export function ForwardView({ slug, bookmark, onRetry }: ForwardViewProps): ReactElement {
  const { t } = useTranslation();
  const choose = useGoChoose();
  const { mutate } = choose;
  const started = useRef(false);
  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    mutate({ slug, bookmarkId: bookmark.id, remember: false });
  }, [mutate, slug, bookmark.id]);

  if (choose.isError) {
    return (
      <Banner
        action={
          <Button onClick={onRetry} size="sm" variant="outline">
            {t("go.retry")}
          </Button>
        }
        description={t("go.forward.failed.description")}
        title={t("go.forward.failed.title")}
        variant="error"
      />
    );
  }
  return <Loading className="p-0" label={t("go.forward.opening", { title: bookmark.title })} />;
}

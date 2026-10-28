import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import { readPageMetadata, type BookmarkMetadata } from "./bookmarks.ts";

export interface PageMetadata {
  /** Whether a request is running. */
  readonly pending: boolean;
  /** Asks for the metadata of `url` and hands the answer to `onMetadata`; nothing happens for an address already asked for. */
  readonly request: (url: string, onMetadata: (metadata: BookmarkMetadata) => void) => void;
  /** Tells that the address is now `url`: a request for another address is dropped. */
  readonly follow: (url: string) => void;
  /** Drops the request that is running. */
  readonly cancel: () => void;
}

interface Run {
  readonly url: string;
  readonly controller: AbortController;
}

/**
 * The page metadata requests of the bookmark form. One request runs at a time: a new address aborts the one before, and an
 * answer that is not the current request's (it was aborted, the address changed, the form closed) is dropped.
 */
export function usePageMetadata(api: ApiClient): PageMetadata {
  const running = useRef<Run | undefined>(undefined);
  const answered = useRef<string | undefined>(undefined);
  const [pending, setPending] = useState(false);

  const cancel = useCallback((): void => {
    running.current?.controller.abort();
    running.current = undefined;
    answered.current = undefined;
    setPending(false);
  }, []);

  const follow = useCallback(
    (url: string): void => {
      if (running.current !== undefined && running.current.url !== url) {
        cancel();
      } else if (answered.current !== undefined && answered.current !== url) {
        answered.current = undefined;
      }
    },
    [cancel],
  );

  const request = useCallback(
    (url: string, onMetadata: (metadata: BookmarkMetadata) => void): void => {
      if (running.current?.url === url || answered.current === url) {
        return;
      }
      running.current?.controller.abort();
      const run: Run = { url, controller: new AbortController() };
      running.current = run;
      answered.current = undefined;
      setPending(true);
      void readPageMetadata(api, url, run.controller.signal).then((metadata) => {
        if (running.current !== run) {
          return;
        }
        running.current = undefined;
        setPending(false);
        if (metadata !== undefined) {
          answered.current = url;
          onMetadata(metadata);
        }
      });
    },
    [api],
  );

  useEffect(
    () => () => {
      running.current?.controller.abort();
      running.current = undefined;
    },
    [],
  );

  return { pending, request, follow, cancel };
}

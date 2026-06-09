import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import type { BookmarkModalAiContext } from "./ai/bookmark-modal-ai.types.js";
import { DEFAULT_BOOKMARK_MODAL_AI_CONTEXT } from "./ai/bookmark-modal-ai.types.js";
import { BookmarkModal } from "./BookmarkModal.js";
import {
  BookmarkModalLoadError,
  loadBookmarkModalOptions,
  submitBookmarkModal,
} from "./bookmark-modal-api.js";
import type {
  BookmarkModalFolderOption,
  BookmarkModalInitialBookmark,
  BookmarkModalSubmitPayload,
  BookmarkModalTagOption,
} from "./bookmark-modal.types.js";
import { useAppLocale } from "../../i18n/use-app-locale.js";
import { useAppToast } from "../feedback/AppToastProvider.js";

export interface BookmarkModalContextValue {
  open: boolean;
  mode: "create" | "edit";
  openCreate: () => void;
  openEdit: (bookmark: BookmarkModalInitialBookmark) => void;
  close: () => void;
}

const BookmarkModalContext = createContext<BookmarkModalContextValue | null>(null);

export type BookmarkModalProviderProps = {
  children: ReactNode;
  onSubmit?: (
    payload: BookmarkModalSubmitPayload,
    initial?: BookmarkModalInitialBookmark,
  ) => Promise<void>;
  /** When omitted, AI suggestions stay disabled until wired from session/workspace loaders. */
  aiContext?: Partial<BookmarkModalAiContext>;
};

export function BookmarkModalProvider({
  children,
  onSubmit = submitBookmarkModal,
  aiContext: aiContextOverride,
}: BookmarkModalProviderProps) {
  const appLocale = useAppLocale();
  const { t } = useTranslation();
  const { showError } = useAppToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [bookmark, setBookmark] = useState<BookmarkModalInitialBookmark | undefined>();
  const [folders, setFolders] = useState<BookmarkModalFolderOption[]>([]);
  const [tags, setTags] = useState<BookmarkModalTagOption[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const loadIdRef = useRef(0);

  const loadOptions = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    setOptionsError(null);
    try {
      const options = await loadBookmarkModalOptions();
      if (loadId === loadIdRef.current) {
        setFolders(options.folders);
        setTags(options.tags);
      }
    } catch (error) {
      if (loadId !== loadIdRef.current) return;
      const message =
        error instanceof BookmarkModalLoadError
          ? error.message
          : t("bookmark.modal.error.load_options_failed");
      setOptionsError(message);
      showError(t("bookmark.modal.error.load_options_toast"));
    }
  }, [t, showError]);

  const openCreate = useCallback(() => {
    setMode("create");
    setBookmark(undefined);
    setOpen(true);
    void loadOptions();
  }, [loadOptions]);

  const openEdit = useCallback(
    (nextBookmark: BookmarkModalInitialBookmark) => {
      setMode("edit");
      setBookmark(nextBookmark);
      setOpen(true);
      void loadOptions();
    },
    [loadOptions],
  );

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- real-world edge case: event.key can be undefined in some IME/browser scenarios
      event.key?.toLowerCase() !== "c" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }

      event.preventDefault();
      openCreate();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openCreate]);

  const handleSubmit = useCallback(
    async (payload: BookmarkModalSubmitPayload) => {
      setIsSubmitting(true);
      try {
        await onSubmit(payload, bookmark);
      } finally {
        setIsSubmitting(false);
      }
    },
    [bookmark, onSubmit],
  );

  const aiContext = useMemo<BookmarkModalAiContext>(
    () => ({
      ...DEFAULT_BOOKMARK_MODAL_AI_CONTEXT,
      outputLanguage: appLocale,
      ...aiContextOverride,
    }),
    [aiContextOverride, appLocale],
  );

  const value = useMemo(
    () => ({
      open,
      mode,
      openCreate,
      openEdit,
      close,
    }),
    [close, mode, open, openCreate, openEdit],
  );

  return (
    <BookmarkModalContext.Provider value={value}>
      {children}
      <BookmarkModal
        open={open}
        onOpenChange={setOpen}
        mode={mode}
        bookmark={bookmark}
        folders={folders}
        tags={tags}
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
        aiContext={aiContext}
        optionsError={optionsError}
        onRetryOptions={() => { void loadOptions(); }}
      />
    </BookmarkModalContext.Provider>
  );
}

export function useBookmarkModal(): BookmarkModalContextValue {
  const ctx = useContext(BookmarkModalContext);
  if (!ctx) {
    throw new Error("useBookmarkModal must be used within BookmarkModalProvider");
  }
  return ctx;
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ListPageMeta = {
  subLabel?: string;
  count?: number;
};

type ListPageMetaContextValue = {
  meta: ListPageMeta;
  setMeta: (meta: ListPageMeta) => void;
};

const ListPageMetaContext = createContext<ListPageMetaContextValue | null>(
  null,
);

export function ListPageMetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMetaState] = useState<ListPageMeta>({});
  const setMeta = useCallback((next: ListPageMeta) => {
    setMetaState(next);
  }, []);

  const value = useMemo(
    () => ({ meta, setMeta }),
    [meta, setMeta],
  );

  return (
    <ListPageMetaContext.Provider value={value}>
      {children}
    </ListPageMetaContext.Provider>
  );
}

/**
 * Read list-page top-bar meta, or register meta when `next` is passed.
 * Pages call `useListPageMeta({ subLabel, count })` on mount; `AppTopBar` reads with no args.
 */
export function useListPageMeta(next?: ListPageMeta): ListPageMeta {
  const context = useContext(ListPageMetaContext);
  if (!context) {
    throw new Error("useListPageMeta must be used within ListPageMetaProvider");
  }

  useEffect(() => {
    if (next === undefined) return;
    context.setMeta(next);
    return () => {
      context.setMeta({});
    };
  }, [context, next?.count, next?.subLabel]);

  return context.meta;
}

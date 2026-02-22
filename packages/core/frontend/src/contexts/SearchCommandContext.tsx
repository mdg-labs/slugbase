import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface SearchCommandContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openSearch: () => void;
}

const SearchCommandContext = createContext<SearchCommandContextValue | null>(null);

export function SearchCommandProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSearch = useCallback(() => setOpen(true), []);
  const value: SearchCommandContextValue = { open, setOpen, openSearch };
  return (
    <SearchCommandContext.Provider value={value}>
      {children}
    </SearchCommandContext.Provider>
  );
}

export function useSearchCommand(): SearchCommandContextValue {
  const ctx = useContext(SearchCommandContext);
  if (!ctx) {
    throw new Error('useSearchCommand must be used within SearchCommandProvider');
  }
  return ctx;
}

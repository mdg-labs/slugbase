import { useLayoutEffect, type ReactElement, type ReactNode } from "react";
import "./ladle.css";

// Ladle's own typings import their modules without file extensions, which the
// NodeNext resolution of this repository cannot follow, so the provider declares
// the part of Ladle's global state it reads. Ladle's story scanner also reads
// only `export const` declarations from this file. The toolbar's values are
// "light", "dark" and "auto".
interface ProviderProps {
  children: ReactNode;
  globalState: { theme: string };
}

function resolveTheme(theme: string): "light" | "dark" {
  if (theme === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme === "dark" ? "dark" : "light";
}

/**
 * Applies the toolbar's theme the way ThemeProvider does: a `light` or `dark`
 * class on the root element, which theme.css styles.
 */
export const Provider = ({ children, globalState }: ProviderProps): ReactElement => {
  const theme = globalState.theme;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolveTheme(theme));
  }, [theme]);

  return <div className="bg-background p-4 text-foreground">{children}</div>;
};

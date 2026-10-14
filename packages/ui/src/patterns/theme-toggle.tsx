import { MoonIcon, SunIcon } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { useTheme, type ResolvedTheme } from "../theme/theme-provider.tsx";

export interface ThemeToggleProps {
  /** Name of the button and text of its tooltip while the light theme shows: it switches to dark. */
  switchToDark: string;
  /** The same while the dark theme shows: it switches to light. */
  switchToLight: string;
  /** Called with the theme the button switched to, after it applied; the app saves the choice with it. */
  onToggle?: (next: ResolvedTheme) => void;
}

/**
 * The icon button of the top bar that flips the theme between light and dark;
 * the `system` choice is made in the account preferences, where the app also keeps the choice. It needs a ThemeProvider.
 */
export function ThemeToggle({ switchToDark, switchToLight, onToggle }: ThemeToggleProps): ReactElement {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const label = dark ? switchToLight : switchToDark;
  const next: ResolvedTheme = dark ? "light" : "dark";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={() => {
              setTheme(next);
              onToggle?.(next);
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        {dark ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

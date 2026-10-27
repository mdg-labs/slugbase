import { CommandTrigger } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { isApplePlatform } from "./platform.ts";
import { usePaletteState } from "./palette-state.tsx";

/** The top bar's command trigger (doc 03 "App shell"): it opens the palette, and the palette gives focus back to it. */
export function PaletteTrigger(): ReactElement {
  const { t } = useTranslation();
  const { setOpen, triggerRef } = usePaletteState();
  const shortcut = [isApplePlatform() ? "⌘" : t("shortcuts.key.ctrl"), "K"];
  return (
    <CommandTrigger
      label={t("palette.trigger")}
      onClick={() => {
        setOpen(true);
      }}
      ref={triggerRef}
      shortcut={shortcut}
    />
  );
}

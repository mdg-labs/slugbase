import { useShortcut } from "@slugbase/ui";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, type ReactElement, type RefObject } from "react";

/** How long after `G` the key that names the place is waited for. */
const GO_WINDOW_MS = 1500;

/**
 * The places `G` then a key goes to (doc 03 section 14).
 */
const GO_TARGETS = [
  { key: "h", to: "/" },
  { key: "b", to: "/bookmarks" },
  { key: "f", to: "/folders" },
  { key: "t", to: "/tags" },
  { key: "w", to: "/forwarding" },
] as const;

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta"]);

function GoTarget({ shortcutKey, to, armedUntil }: { readonly shortcutKey: string; readonly to: (typeof GO_TARGETS)[number]["to"]; readonly armedUntil: RefObject<number> }): null {
  const router = useRouter();
  useShortcut({ key: shortcutKey }, () => {
    if (Date.now() < armedUntil.current) {
      armedUntil.current = 0;
      void router.navigate({ to });
    }
  });
  return null;
}

/**
 * The `G` then `H` / `B` / `F` / `T` / `W` navigation sequences. `G` arms the sequence for a moment; the next key goes to its place when it
 * names one. Any other key that is released first ends the sequence. They are single-key shortcuts, so they follow the
 * account's switch, and stay quiet in text fields and overlays.
 */
export function GoShortcuts(): ReactElement {
  const armedUntil = useRef(0);
  useShortcut({ key: "g" }, () => {
    armedUntil.current = Date.now() + GO_WINDOW_MS;
  });
  useEffect(() => {
    const disarm = (event: KeyboardEvent): void => {
      if (event.key !== "g" && !MODIFIER_KEYS.has(event.key)) {
        armedUntil.current = 0;
      }
    };
    window.addEventListener("keyup", disarm);
    return () => {
      window.removeEventListener("keyup", disarm);
    };
  }, []);
  return (
    <>
      {GO_TARGETS.map(({ key, to }) => (
        <GoTarget armedUntil={armedUntil} key={key} shortcutKey={key} to={to} />
      ))}
    </>
  );
}

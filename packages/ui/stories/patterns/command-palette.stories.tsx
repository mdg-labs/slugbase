import type { StoryDefault } from "@ladle/react";
import { BookmarkIcon, HomeIcon, TagIcon } from "lucide-react";
import { useRef, useState } from "react";
import { CommandPalette, CommandTrigger, type CommandPaletteHint, type CommandPaletteSection } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Command palette",
  parameters: { subject: ["CommandPalette", "CommandTrigger"] },
} satisfies StoryDefault;

const HINTS: readonly CommandPaletteHint[] = [
  { id: "move", keys: ["↑", "↓"], label: "navigate" },
  { id: "open", keys: ["↵"], label: "open" },
  { id: "tab", keys: ["Ctrl", "↵"], label: "new tab" },
  { id: "edit", keys: ["Alt", "↵"], label: "edit" },
  { id: "close", keys: ["esc"], label: "close" },
];

const READY: readonly CommandPaletteSection[] = [
  {
    id: "recent",
    title: "Recent",
    items: [{ id: "docs", label: "Docs", detail: "docs.example.org", icon: <BookmarkIcon aria-hidden="true" />, keywords: "docs.example.org", onSelect: () => undefined }],
  },
  {
    id: "navigation",
    title: "Navigation",
    items: [
      { id: "home", label: "Home", icon: <HomeIcon aria-hidden="true" />, shortcut: ["G", "H"], onSelect: () => undefined },
      { id: "tags", label: "Tags", icon: <TagIcon aria-hidden="true" />, shortcut: ["G", "T"], onSelect: () => undefined },
    ],
  },
];

const LOADING: readonly CommandPaletteSection[] = [
  { id: "recent", title: "Recent", state: "loading", loadingLabel: "Loading recent bookmarks" },
  READY[1] as CommandPaletteSection,
];

const FAILED: readonly CommandPaletteSection[] = [
  { id: "recent", title: "Recent", state: "error", error: { message: "Recent bookmarks could not be loaded.", retryLabel: "Retry", onRetry: () => undefined } },
  READY[1] as CommandPaletteSection,
];

const EMPTY: readonly CommandPaletteSection[] = [
  { id: "bookmarks", state: "empty", notice: { title: "No bookmarks yet", description: "Recent and pinned bookmarks show up here." } },
  READY[1] as CommandPaletteSection,
];

function Palette({ sections, initiallyOpen = false }: { sections: readonly CommandPaletteSection[]; initiallyOpen?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <CommandTrigger
        label="Search or run a command…"
        onClick={() => {
          setOpen(true);
        }}
        ref={trigger}
        shortcut={["Ctrl", "K"]}
      />
      <CommandPalette
        announce={(count) => `${String(count)} results`}
        closeLabel="Close the palette"
        finalFocus={trigger}
        footerHints={HINTS}
        inputLabel="Search or run a command"
        noResults="No results"
        onOpenChange={setOpen}
        open={open}
        placeholder="Search or run a command…"
        sections={sections}
        title="Command palette"
      />
    </>
  );
}

export const Default = (): React.ReactElement => <Palette sections={READY} />;

export const Open = (): React.ReactElement => <Palette initiallyOpen sections={READY} />;

export const Loading = (): React.ReactElement => <Palette initiallyOpen sections={LOADING} />;

export const Failed = (): React.ReactElement => <Palette initiallyOpen sections={FAILED} />;

export const NothingYet = (): React.ReactElement => <Palette initiallyOpen sections={EMPTY} />;

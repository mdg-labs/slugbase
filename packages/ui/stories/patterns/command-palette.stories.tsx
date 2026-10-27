import type { StoryDefault } from "@ladle/react";
import { BookmarkIcon, HomeIcon, PlusIcon, TagIcon } from "lucide-react";
import { useRef, useState } from "react";
import { CommandPalette, CommandTrigger, SlugChip, type CommandPaletteHint, type CommandPaletteNoResultsAction, type CommandPaletteSection } from "../../src/patterns/index.ts";

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

// The items of a search the app ran: the palette lists them as they are, whatever the query says.
const FOUND: readonly CommandPaletteSection[] = [
  {
    id: "bookmarks",
    title: "Bookmarks",
    prefiltered: true,
    items: [
      {
        id: "handbook",
        label: "Team handbook",
        icon: <BookmarkIcon aria-hidden="true" />,
        detail: (
          <span className="flex min-w-0 items-center gap-2">
            <SlugChip slug="docs" />
            <span className="truncate">docs.example.org</span>
          </span>
        ),
        onSelect: () => undefined,
      },
    ],
  },
  READY[1] as CommandPaletteSection,
];

const CREATE: CommandPaletteNoResultsAction = { label: "Create a bookmark with the slug zzz", icon: <PlusIcon aria-hidden="true" />, onSelect: () => undefined };

function Palette({
  sections,
  initiallyOpen = false,
  noResultsAction,
}: {
  sections: readonly CommandPaletteSection[];
  initiallyOpen?: boolean;
  noResultsAction?: CommandPaletteNoResultsAction;
}): React.ReactElement {
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
        {...(noResultsAction === undefined ? {} : { noResultsAction })}
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

export const Found = (): React.ReactElement => <Palette initiallyOpen sections={FOUND} />;

/** Type a query that matches nothing, such as "zzz", to see the offer under "No results". */
export const NoResultsOffer = (): React.ReactElement => <Palette initiallyOpen noResultsAction={CREATE} sections={READY} />;

import type { ReactElement } from "react";
import { Avatar, AvatarFallback } from "../components/ui/avatar.tsx";
import { cn } from "../lib/utils.ts";

export interface AccountAvatarProps {
  /** The display name the initials come from. */
  name: string;
  /** The account identifier the colour is derived from, so an account keeps its colour whatever its name. */
  seed: string;
  /** The preview size; the avatar in the top bar is `sm`. */
  size?: "sm" | "lg";
  className?: string;
}

// The fixed colour set of the folders (doc 03 "Theme tokens"): eight tokens that hold in both themes.
// `text-background` is the page colour, which reads on a fill in either theme.
const COLOURS = [
  "bg-folder-1",
  "bg-folder-2",
  "bg-folder-3",
  "bg-folder-4",
  "bg-folder-5",
  "bg-folder-6",
  "bg-folder-7",
  "bg-folder-8",
] as const;

const FNV_OFFSET = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;

/** The colour class an account identifier maps to: FNV-1a over its UTF-16 code units, modulo the colour set. */
export function avatarColour(seed: string): (typeof COLOURS)[number] {
  let hash = FNV_OFFSET;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return COLOURS[(hash >>> 0) % COLOURS.length] ?? COLOURS[0];
}

/** The first letter of the first word and of the last word of a name, upper-cased; one word gives one letter. */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/u).filter((word) => word !== "");
  const first = words[0];
  const last = words.length > 1 ? words.at(-1) : undefined;
  return [first, last]
    .flatMap((word) => (word === undefined ? [] : [Array.from(word)[0] ?? ""]))
    .join("")
    .toLocaleUpperCase();
}

/**
 * The account's avatar (doc 02 section 2.1, Q37): initials on a colour derived from the account
 * identifier. There are no uploads. The initials repeat the name that stands beside the avatar, so
 * assistive technology skips them.
 */
export function AccountAvatar({ name, seed, size = "sm", className }: AccountAvatarProps): ReactElement {
  return (
    <Avatar aria-hidden="true" className={cn(size === "lg" ? "size-16 text-xl" : "size-6", className)}>
      <AvatarFallback className={cn("font-semibold text-background", avatarColour(seed))}>{initialsOf(name)}</AvatarFallback>
    </Avatar>
  );
}

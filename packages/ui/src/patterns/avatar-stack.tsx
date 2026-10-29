import type { ReactElement } from "react";
import { cn } from "../lib/utils.ts";
import { AccountAvatar } from "./account-avatar.tsx";

export interface AvatarStackPerson {
  /** The account identifier the avatar's colour comes from. */
  id: string;
  /** The display name the avatar's initials come from. */
  name: string;
}

export interface AvatarStackProps {
  /** The people to show, in order; the first `max` get an avatar. */
  people: readonly AvatarStackPerson[];
  /** How many avatars to show before the rest are counted in a "+N" chip; 4 by default. */
  max?: number;
  /** What assistive technology announces for the whole stack, for example the names of the people. */
  label: string;
  className?: string;
}

const DEFAULT_MAX = 4;

/**
 * Overlapping avatars of a group of people (doc 03 `avatar-stack`), with a "+N" chip for those beyond `max`. The stack is one
 * image to assistive technology, named by `label`, since the initials only repeat names that are listed elsewhere.
 */
export function AvatarStack({ people, max = DEFAULT_MAX, label, className }: AvatarStackProps): ReactElement {
  const shown = people.slice(0, Math.max(0, max));
  const rest = people.length - shown.length;
  return (
    <span aria-label={label} className={cn("inline-flex items-center -space-x-2", className)} data-slot="avatar-stack" role="img">
      {shown.map((person) => (
        <AccountAvatar className="ring-2 ring-background" key={person.id} name={person.name} seed={person.id} />
      ))}
      {rest > 0 ? (
        <span
          aria-hidden="true"
          className="relative inline-flex size-6 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs ring-2 ring-background"
          data-slot="avatar-stack-rest"
        >
          {`+${String(rest)}`}
        </span>
      ) : null}
    </span>
  );
}

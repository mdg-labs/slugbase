import type { ReactElement, ReactNode } from "react";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "../components/ui/accordion.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { cn } from "../lib/utils.ts";

export interface GroupedResultsGroup {
  /** Names the group among the others; the accordion keeps its open state under it. */
  id: string;
  /** What the group is, for example the reason its entries were left out. */
  label: ReactNode;
  /** How many entries the group holds; a group with none is not shown. */
  count: number;
  /** The count as the Badge shows it, formatted for the language; the number itself when left out. */
  countLabel?: string;
  /** The entries of the group, shown when it is open. */
  children: ReactNode;
}

export interface GroupedResultsProps {
  groups: readonly GroupedResultsGroup[];
  /** The groups that start open; none by default. */
  defaultOpen?: readonly string[];
  className?: string;
}

/**
 * The entries of a result sorted into groups (doc 03 `grouped-results`): an accordion that lets several groups stay open, with a count
 * Badge on each group's heading. A group without entries is left out.
 */
export function GroupedResults({ groups, defaultOpen, className }: GroupedResultsProps): ReactElement | null {
  const shown = groups.filter((group) => group.count > 0);
  if (shown.length === 0) {
    return null;
  }
  return (
    <Accordion className={cn("w-full", className)} defaultValue={defaultOpen === undefined ? [] : [...defaultOpen]} multiple>
      {shown.map((group) => (
        <AccordionItem key={group.id} value={group.id}>
          <AccordionTrigger>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0">{group.label}</span>
              <Badge size="lg" variant="secondary">
                {group.countLabel ?? String(group.count)}
              </Badge>
            </span>
          </AccordionTrigger>
          <AccordionPanel>{group.children}</AccordionPanel>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

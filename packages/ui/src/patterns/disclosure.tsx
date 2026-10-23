import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronDownIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/utils.ts";

export interface DisclosureProps {
  /** The name of the control that shows and hides the content, for example "More". */
  label: ReactNode;
  children: ReactNode;
  /** Whether the content starts shown. */
  defaultOpen?: boolean;
  className?: string;
}

/** Content hidden behind a control until it is wanted (a Base UI Collapsible, as coss ui builds it): the optional fields of a form. */
export function Disclosure({ label, children, defaultOpen = false, className }: DisclosureProps): ReactElement {
  return (
    <Collapsible.Root className={cn("flex flex-col gap-2", className)} data-slot="collapsible" defaultOpen={defaultOpen}>
      <Collapsible.Trigger
        className="group flex w-fit cursor-pointer items-center gap-1 rounded-md font-medium text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        data-slot="collapsible-trigger"
      >
        <ChevronDownIcon aria-hidden="true" className="size-4 transition-transform group-data-panel-open:rotate-180" />
        {label}
      </Collapsible.Trigger>
      <Collapsible.Panel
        className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 data-ending-style:h-0 data-starting-style:h-0"
        data-slot="collapsible-panel"
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

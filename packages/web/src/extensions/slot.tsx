import type { ReactElement } from "react";
import { useExtensions } from "./extensions-context.tsx";
import type { SlotName } from "./slot-names.ts";

/**
 * A named extension point (doc 03 `slot`): renders the components the extensions
 * registered for `name`, in registration order, or nothing at all. It adds no
 * element of its own, so an empty slot leaves no trace in the DOM.
 */
export function Slot({ name }: { name: SlotName }): ReactElement | null {
  const extensions = useExtensions();
  const filled = extensions.flatMap((extension) => {
    const component = extension.slots?.[name];
    return component === undefined ? [] : [{ id: extension.id, Component: component }];
  });
  if (filled.length === 0) {
    return null;
  }
  return (
    <>
      {filled.map(({ id, Component }) => (
        <Component key={id} />
      ))}
    </>
  );
}

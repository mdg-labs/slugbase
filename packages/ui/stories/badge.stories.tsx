import type { StoryDefault } from "@ladle/react";
import { Badge } from "../src/index.ts";

export default {
  title: "Badge",
  parameters: { subject: ["Badge"] },
} satisfies StoryDefault;

export const Variants = (): React.ReactElement => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge>Default</Badge>
    <Badge variant="secondary">Secondary</Badge>
    <Badge variant="outline">Outline</Badge>
    <Badge variant="info">Info</Badge>
    <Badge variant="success">Success</Badge>
    <Badge variant="warning">Warning</Badge>
    <Badge variant="error">Error</Badge>
  </div>
);

export const Sizes = (): React.ReactElement => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge size="sm" variant="outline">
      Small
    </Badge>
    <Badge variant="outline">Default</Badge>
    <Badge size="lg" variant="outline">
      Large
    </Badge>
  </div>
);

/** A badge rendered as a button, for a choice such as a suggestion the member can take. */
export const Selectable = (): React.ReactElement => (
  <Badge render={<button type="button" />} size="lg" variant="outline">
    Select me
  </Badge>
);

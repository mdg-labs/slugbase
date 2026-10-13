import type { StoryDefault } from "@ladle/react";
import { PlusIcon } from "lucide-react";
import { Button } from "../src/index.ts";

const VARIANTS = ["default", "secondary", "outline", "ghost", "link", "destructive", "destructive-outline"] as const;
const SIZES = ["xs", "sm", "default", "lg", "xl"] as const;

export default {
  title: "Button",
  parameters: { subject: ["Button"] },
} satisfies StoryDefault;

export const Variants = (): React.ReactElement => (
  <div className="flex flex-wrap gap-3">
    {VARIANTS.map((variant) => (
      <Button key={variant} variant={variant}>
        {variant}
      </Button>
    ))}
  </div>
);

export const Sizes = (): React.ReactElement => (
  <div className="flex flex-wrap items-center gap-3">
    {SIZES.map((size) => (
      <Button key={size} size={size}>
        {size}
      </Button>
    ))}
  </div>
);

export const WithIcon = (): React.ReactElement => (
  <div className="flex flex-wrap items-center gap-3">
    <Button>
      <PlusIcon aria-hidden="true" />
      Add bookmark
    </Button>
    <Button aria-label="Add bookmark" size="icon">
      <PlusIcon aria-hidden="true" />
    </Button>
  </div>
);

export const Loading = (): React.ReactElement => <Button loading>Saving</Button>;

export const Disabled = (): React.ReactElement => <Button disabled>Unavailable</Button>;

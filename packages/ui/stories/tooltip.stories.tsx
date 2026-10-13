import type { StoryDefault } from "@ladle/react";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipCreateHandle,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "../src/index.ts";

export default {
  title: "Tooltip",
  parameters: { subject: ["Tooltip", "TooltipContent", "TooltipCreateHandle", "TooltipPopup", "TooltipProvider", "TooltipTrigger"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <TooltipProvider>
    <Tooltip defaultOpen>
      <TooltipTrigger render={<Button variant="outline" />}>Pin</TooltipTrigger>
      <TooltipPopup>Pin this bookmark</TooltipPopup>
    </Tooltip>
  </TooltipProvider>
);

export const Aliased = (): React.ReactElement => (
  <TooltipProvider>
    <Tooltip defaultOpen>
      <TooltipTrigger render={<Button variant="outline" />}>Share</TooltipTrigger>
      <TooltipContent side="bottom">Share this folder</TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

const handle = TooltipCreateHandle();

export const Detached = (): React.ReactElement => (
  <TooltipProvider>
    <TooltipTrigger handle={handle} render={<Button variant="outline" />}>
      Copy
    </TooltipTrigger>
    <Tooltip defaultOpen handle={handle}>
      <TooltipPopup>Copy the slug</TooltipPopup>
    </Tooltip>
  </TooltipProvider>
);

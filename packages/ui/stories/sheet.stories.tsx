import type { StoryDefault } from "@ladle/react";
import {
  Button,
  Sheet,
  SheetBackdrop,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
  SheetViewport,
} from "../src/index.ts";

export default {
  title: "Sheet",
  parameters: { subject: ["Sheet", "SheetBackdrop", "SheetClose", "SheetDescription", "SheetFooter", "SheetHeader", "SheetPanel", "SheetPopup", "SheetTitle", "SheetTrigger", "SheetViewport"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <Sheet>
    <SheetTrigger render={<Button variant="outline" />}>Open sheet</SheetTrigger>
    <SheetPopup>
      <SheetHeader>
        <SheetTitle>Folder preview</SheetTitle>
        <SheetDescription>Bookmarks in this folder.</SheetDescription>
      </SheetHeader>
      <SheetPanel>
        <p>Panel content</p>
      </SheetPanel>
      <SheetFooter>
        <SheetClose render={<Button variant="outline" />}>Done</SheetClose>
      </SheetFooter>
    </SheetPopup>
  </Sheet>
);

export const Open = (): React.ReactElement => (
  <Sheet defaultOpen>
    <SheetTrigger render={<Button variant="outline" />}>Open sheet</SheetTrigger>
    <SheetPopup side="left">
      <SheetHeader>
        <SheetTitle>Folder preview</SheetTitle>
        <SheetDescription>Bookmarks in this folder.</SheetDescription>
      </SheetHeader>
    </SheetPopup>
  </Sheet>
);

export const Composed = (): React.ReactElement => (
  <Sheet defaultOpen>
    <SheetTrigger render={<Button variant="outline" />}>Open sheet</SheetTrigger>
    <SheetPortal>
      <SheetBackdrop />
      <SheetViewport>
        <SheetPopup showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>Composed sheet</SheetTitle>
            <SheetDescription>Built from its parts.</SheetDescription>
          </SheetHeader>
        </SheetPopup>
      </SheetViewport>
    </SheetPortal>
  </Sheet>
);

import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Button } from "../../src/index.ts";
import { Confirm } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Confirm",
  parameters: { subject: ["Confirm"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
        variant="outline"
      >
        Sign out everywhere else
      </Button>
      <Confirm
        cancelLabel="Cancel"
        confirmLabel="Sign out everywhere else"
        description="Every other session of your account is signed out. This device stays signed in."
        destructive
        onConfirm={() => {
          setOpen(false);
        }}
        onOpenChange={setOpen}
        open={open}
        title="Sign out everywhere else?"
      />
    </>
  );
};

export const Open = (): React.ReactElement => (
  <>
    <p>The page behind the dialog.</p>
    <Confirm
    cancelLabel="Cancel"
    confirmLabel="Remove"
    description="The 9 bookmarks stay; only the folder goes."
    onConfirm={() => undefined}
    onOpenChange={() => undefined}
    open
    title="Delete the folder?"
  />
  </>
);

export const Working = (): React.ReactElement => (
  <>
    <p>The page behind the dialog.</p>
    <Confirm
    cancelLabel="Cancel"
    confirmLabel="Sign out"
    description="This ends the session you are using now."
    destructive
    loading
    onConfirm={() => undefined}
    onOpenChange={() => undefined}
    open
    title="Sign out of this device?"
  />
  </>
);

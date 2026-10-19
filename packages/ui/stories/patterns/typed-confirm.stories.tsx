import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Button } from "../../src/index.ts";
import { CheckboxField, TypedConfirm } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/TypedConfirm",
  parameters: { subject: ["TypedConfirm"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => {
  const [open, setOpen] = useState(false);
  const [stayAdmin, setStayAdmin] = useState(true);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
        variant="outline"
      >
        Transfer ownership
      </Button>
      <TypedConfirm
        cancelLabel="Cancel"
        confirmLabel="Transfer ownership"
        description="Grace Hopper becomes an owner of the workspace and can manage its members and settings."
        destructive
        expected="Grace Hopper"
        inputLabel="Type Grace Hopper to confirm"
        onConfirm={() => {
          setOpen(false);
        }}
        onOpenChange={setOpen}
        open={open}
        title="Transfer ownership to Grace Hopper?"
      >
        <CheckboxField checked={stayAdmin} label="Stay as admin" onCheckedChange={setStayAdmin} />
      </TypedConfirm>
    </>
  );
};

export const Open = (): React.ReactElement => (
  <>
    <p>The page behind the dialog.</p>
    <TypedConfirm
      cancelLabel="Cancel"
      confirmLabel="Delete workspace"
      description="The workspace and everything in it is deleted. This cannot be undone."
      destructive
      expected="Ada's Workspace"
      inputLabel="Type Ada's Workspace to confirm"
      onConfirm={() => undefined}
      onOpenChange={() => undefined}
      open
      title="Delete Ada's Workspace?"
    />
  </>
);

export const Failed = (): React.ReactElement => (
  <>
    <p>The page behind the dialog.</p>
    <TypedConfirm
      cancelLabel="Cancel"
      confirmLabel="Transfer ownership"
      description="Grace Hopper becomes an owner of the workspace."
      error="The ownership could not be transferred. Try again."
      expected="Grace Hopper"
      inputLabel="Type Grace Hopper to confirm"
      onConfirm={() => undefined}
      onOpenChange={() => undefined}
      open
      title="Transfer ownership to Grace Hopper?"
    />
  </>
);

export const Working = (): React.ReactElement => (
  <>
    <p>The page behind the dialog.</p>
    <TypedConfirm
      cancelLabel="Cancel"
      confirmLabel="Transfer ownership"
      description="Grace Hopper becomes an owner of the workspace."
      expected="Grace Hopper"
      inputLabel="Type Grace Hopper to confirm"
      loading
      onConfirm={() => undefined}
      onOpenChange={() => undefined}
      open
      title="Transfer ownership to Grace Hopper?"
    />
  </>
);

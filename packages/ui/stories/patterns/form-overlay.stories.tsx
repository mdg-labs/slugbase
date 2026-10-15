import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Button } from "../../src/index.ts";
import { FormField, FormOverlay, SecretInput } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Form overlay",
  parameters: { subject: ["FormOverlay"] },
} satisfies StoryDefault;

function PasswordForm({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <FormField label="Password" name="password">
        <SecretInput autoComplete="current-password" hideLabel="Hide password" showLabel="Show password" />
      </FormField>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} variant="outline">
          Cancel
        </Button>
        <Button type="submit">Confirm</Button>
      </div>
    </form>
  );
}

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
        Change password
      </Button>
      <FormOverlay
        closeLabel="Close"
        description="This change needs your password again."
        onOpenChange={setOpen}
        open={open}
        title="Confirm it is you"
      >
        <PasswordForm
          onClose={() => {
            setOpen(false);
          }}
        />
      </FormOverlay>
    </>
  );
};

export const Open = (): React.ReactElement => (
  <>
    <p>The page behind the overlay.</p>
    <FormOverlay closeLabel="Close" description="This change needs your password again." onOpenChange={() => undefined} open title="Confirm it is you">
      <PasswordForm onClose={() => undefined} />
    </FormOverlay>
  </>
);

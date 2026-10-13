import type { StoryDefault } from "@ladle/react";
import { useEffect } from "react";
import { AnchoredToastProvider, Button, ToastProvider, anchoredToastManager, toastManager } from "../src/index.ts";

export default {
  title: "Toast",
  parameters: { subject: ["AnchoredToastProvider", "ToastProvider"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => {
  useEffect(() => {
    toastManager.add({ title: "Bookmark pinned", description: "It is at the top of your list." });
  }, []);

  return (
    <ToastProvider>
      <Button
        onClick={() => {
          toastManager.add({ title: "Bookmark pinned", description: "It is at the top of your list." });
        }}
        variant="outline"
      >
        Show toast
      </Button>
    </ToastProvider>
  );
};

export const Anchored = (): React.ReactElement => (
  <AnchoredToastProvider>
    <Button
      onClick={(event) => {
        anchoredToastManager.add({
          title: "Copied",
          positionerProps: { anchor: event.currentTarget },
        });
      }}
      variant="outline"
    >
      Copy slug
    </Button>
  </AnchoredToastProvider>
);

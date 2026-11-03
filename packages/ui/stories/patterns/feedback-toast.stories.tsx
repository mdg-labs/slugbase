import type { StoryDefault } from "@ladle/react";
import { Button } from "../../src/index.ts";
import { FeedbackToastProvider, feedbackToast } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Feedback toast",
  parameters: { subject: ["FeedbackToastProvider"] },
} satisfies StoryDefault;

export const Kinds = (): React.ReactElement => (
  <FeedbackToastProvider regionLabel="Notifications">
    <div className="flex gap-2 p-6">
      <Button
        onClick={() => {
          feedbackToast.info("Signed out", "Sign in again to continue.");
        }}
        variant="outline"
      >
        Info
      </Button>
      <Button
        onClick={() => {
          feedbackToast.success("Bookmark pinned");
        }}
        variant="outline"
      >
        Success
      </Button>
      <Button
        onClick={() => {
          feedbackToast.error("The change was not saved", "Try again.");
        }}
        variant="outline"
      >
        Error
      </Button>
    </div>
  </FeedbackToastProvider>
);

export const FollowingAPromise = (): React.ReactElement => (
  <FeedbackToastProvider regionLabel="Notifications">
    <div className="flex gap-2 p-6">
      <Button
        onClick={() => {
          void feedbackToast.promise(new Promise<void>((resolve) => setTimeout(resolve, 1500)), {
            loading: "Preparing the file",
            success: "The file was saved",
            error: "The file was not saved",
          });
        }}
        variant="outline"
      >
        Succeeds
      </Button>
      <Button
        onClick={() => {
          feedbackToast
            .promise(new Promise<void>((_resolve, reject) => setTimeout(reject, 1500, new Error("refused"))), {
              loading: "Preparing the file",
              success: "The file was saved",
              error: { title: "The file was not saved", description: "Try again in 30 seconds." },
            })
            .catch(() => undefined);
        }}
        variant="outline"
      >
        Fails
      </Button>
    </div>
  </FeedbackToastProvider>
);

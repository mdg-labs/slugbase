import type { StoryDefault } from "@ladle/react";
import { Button } from "../../src/index.ts";
import { Banner } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Banner",
  parameters: { subject: ["Banner"] },
} satisfies StoryDefault;

export const Offline = (): React.ReactElement => (
  <Banner description="Changes are not saved until the connection is back." title="You are offline" variant="warning" />
);

export const WithAction = (): React.ReactElement => (
  <Banner
    action={<Button size="sm">Resend email</Button>}
    description="Confirm your address to keep signing in with it."
    title="Your email is not verified"
  />
);

export const Error = (): React.ReactElement => (
  <Banner
    action={<Button size="sm">Retry</Button>}
    description="The list could not be loaded."
    title="Something went wrong"
    variant="error"
  />
);

export const Success = (): React.ReactElement => <Banner title="Import finished" variant="success" />;

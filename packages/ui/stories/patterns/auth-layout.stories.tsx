import type { StoryDefault } from "@ladle/react";
import { AuthLayout } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Auth layout",
  parameters: { subject: ["AuthLayout"] },
} satisfies StoryDefault;

export const Narrow = (): React.ReactElement => (
  <AuthLayout footer="English · Deutsch" productName="SlugBase">
    <p className="text-center text-sm">The sign-in card goes here.</p>
  </AuthLayout>
);

export const Wide = (): React.ReactElement => (
  <AuthLayout productName="SlugBase" size="md">
    <p className="text-center text-sm">A wizard goes here.</p>
  </AuthLayout>
);

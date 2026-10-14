import type { StoryDefault } from "@ladle/react";
import { Button, Input } from "../../src/index.ts";
import { AuthCard, FormField } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Auth card",
  parameters: { subject: ["AuthCard"] },
} satisfies StoryDefault;

export const SignIn = (): React.ReactElement => (
  <AuthCard description="Welcome back." footer="English · Deutsch" productName="SlugBase" title="Sign in">
    <form className="flex flex-col gap-4">
      <FormField label="Email">
        <Input autoComplete="username" type="email" />
      </FormField>
      <Button type="submit">Sign in</Button>
    </form>
  </AuthCard>
);

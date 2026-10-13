import type { StoryDefault } from "@ladle/react";
import { ThemeProvider } from "../../src/index.ts";
import { ThemeToggle } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Theme toggle",
  parameters: { subject: ["ThemeToggle"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <ThemeProvider>
    <ThemeToggle switchToDark="Switch to dark theme" switchToLight="Switch to light theme" />
  </ThemeProvider>
);

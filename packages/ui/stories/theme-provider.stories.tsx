import type { StoryDefault } from "@ladle/react";
import { Button, ThemeProvider, useTheme, type Theme } from "../src/index.ts";

const CHOICES = ["light", "dark", "system"] as const satisfies readonly Theme[];

function ThemeChoices(): React.ReactElement {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div className="flex flex-col gap-3">
      <p>{`Choice: ${theme}, showing: ${resolvedTheme}`}</p>
      <div className="flex gap-2">
        {CHOICES.map((choice) => (
          <Button
            key={choice}
            onClick={() => {
              setTheme(choice);
            }}
            variant={choice === theme ? "default" : "outline"}
          >
            {choice}
          </Button>
        ))}
      </div>
    </div>
  );
}

export default {
  title: "Theme Provider",
  parameters: { subject: ["ThemeProvider"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <ThemeProvider storageKey="slugbase-ladle-theme-story">
    <ThemeChoices />
  </ThemeProvider>
);

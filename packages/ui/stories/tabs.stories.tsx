import type { StoryDefault } from "@ladle/react";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../src/index.ts";

export default {
  title: "Tabs",
  parameters: { subject: ["Tabs", "TabsList", "TabsTab", "TabsPanel"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <Tabs defaultValue="chrome">
    <TabsList aria-label="Browser">
      <TabsTab value="chrome">Chrome</TabsTab>
      <TabsTab value="firefox">Firefox</TabsTab>
    </TabsList>
    <TabsPanel value="chrome">Instructions for Chrome.</TabsPanel>
    <TabsPanel value="firefox">Instructions for Firefox.</TabsPanel>
  </Tabs>
);

export const Underline = (): React.ReactElement => (
  <Tabs defaultValue="chrome">
    <TabsList aria-label="Browser" variant="underline">
      <TabsTab value="chrome">Chrome</TabsTab>
      <TabsTab value="firefox">Firefox</TabsTab>
    </TabsList>
    <TabsPanel value="chrome">Instructions for Chrome.</TabsPanel>
    <TabsPanel value="firefox">Instructions for Firefox.</TabsPanel>
  </Tabs>
);

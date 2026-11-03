import type { StoryDefault } from "@ladle/react";
import { Accordion, AccordionContent, AccordionItem, AccordionPanel, AccordionTrigger } from "../src/index.ts";

export default {
  title: "Accordion",
  parameters: { subject: ["Accordion", "AccordionItem", "AccordionTrigger", "AccordionPanel", "AccordionContent"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <Accordion defaultValue={["first"]}>
    <AccordionItem value="first">
      <AccordionTrigger>What is a slug?</AccordionTrigger>
      <AccordionPanel>A short, private name for a bookmark.</AccordionPanel>
    </AccordionItem>
    <AccordionItem value="second">
      <AccordionTrigger>How do I go to one?</AccordionTrigger>
      <AccordionContent>Type it after /go/.</AccordionContent>
    </AccordionItem>
  </Accordion>
);

export const SeveralOpen = (): React.ReactElement => (
  <Accordion defaultValue={["first", "second"]} multiple>
    <AccordionItem value="first">
      <AccordionTrigger>First</AccordionTrigger>
      <AccordionPanel>First content.</AccordionPanel>
    </AccordionItem>
    <AccordionItem value="second">
      <AccordionTrigger>Second</AccordionTrigger>
      <AccordionPanel>Second content.</AccordionPanel>
    </AccordionItem>
  </Accordion>
);

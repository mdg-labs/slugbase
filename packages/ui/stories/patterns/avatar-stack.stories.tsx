import type { StoryDefault } from "@ladle/react";
import { AvatarStack } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Avatar stack",
  parameters: { subject: ["AvatarStack"] },
} satisfies StoryDefault;

const PEOPLE = [
  { id: "0192f3a0-bbbb-7000-8000-000000000001", name: "Ada Lovelace" },
  { id: "0192f3a0-bbbb-7000-8000-000000000002", name: "Grace Hopper" },
  { id: "0192f3a0-bbbb-7000-8000-000000000003", name: "Alan Turing" },
  { id: "0192f3a0-bbbb-7000-8000-000000000004", name: "Margaret Hamilton" },
  { id: "0192f3a0-bbbb-7000-8000-000000000005", name: "Edsger Dijkstra" },
  { id: "0192f3a0-bbbb-7000-8000-000000000006", name: "Barbara Liskov" },
];

export const Few = (): React.ReactElement => <AvatarStack label="Ada Lovelace and Grace Hopper" people={PEOPLE.slice(0, 2)} />;

export const WithRest = (): React.ReactElement => <AvatarStack label="6 people" people={PEOPLE} />;

export const ShorterStack = (): React.ReactElement => <AvatarStack label="6 people" max={2} people={PEOPLE} />;

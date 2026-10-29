import type { StoryDefault } from "@ladle/react";
import { Favicon } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Favicon",
  parameters: { subject: ["Favicon"] },
} satisfies StoryDefault;

export const Sizes = (): React.ReactElement => (
  <div className="flex items-center gap-3">
    <Favicon host="example.com" />
    <Favicon host="example.com" size={32} />
  </div>
);

export const Monograms = (): React.ReactElement => (
  <div className="flex items-center gap-3">
    {["docs.example.org", "mail.example.org", "www.example.net", "wiki.example.com", "board.example.io", "xn--bcher-kva.example", "shop.example", "status.example"].map((host) => (
      <Favicon host={host} key={host} size={32} />
    ))}
  </div>
);

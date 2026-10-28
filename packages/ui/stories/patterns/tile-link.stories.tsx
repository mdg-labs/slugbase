import type { StoryDefault } from "@ladle/react";
import { SlugChip, TileGrid, TileLink } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/Tile link",
  parameters: { subject: ["TileGrid", "TileLink"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => (
  <TileGrid label="Quick access">
    <TileLink hint="https://example.com/docs" href="/go/docs" host="example.com" title="Example docs">
      <SlugChip slug="docs" />
    </TileLink>
    <TileLink hint="https://mail.example.org/inbox" href="/go/mail" host="mail.example.org" title="Mail">
      <SlugChip slug="mail" />
    </TileLink>
    <TileLink href="https://example.net/read" host="example.com" subtitle="example.net" title="A very long title that is cut off after one line of the tile" />
    <TileLink host="no-link.example" subtitle="no-link.example" title="Without a link" />
  </TileGrid>
);

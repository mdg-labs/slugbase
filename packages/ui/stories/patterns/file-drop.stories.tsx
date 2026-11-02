import type { StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Button } from "../../src/index.ts";
import { FileDrop } from "../../src/patterns/index.ts";

export default {
  title: "Patterns/File drop",
  parameters: { subject: ["FileDrop"] },
} satisfies StoryDefault;

export const Default = (): React.ReactElement => {
  const [file, setFile] = useState<File | undefined>(undefined);
  return (
    <FileDrop
      accept=".json,.html,.htm"
      description="SlugBase JSON or a browser bookmark file, up to 5 MiB."
      dropLabel="Drop a file here, or choose one."
      fileName={file?.name}
      label="File"
      onFile={setFile}
    />
  );
};

export const WithError = (): React.ReactElement => (
  <FileDrop
    action={
      <Button size="sm" variant="outline">
        Try again
      </Button>
    }
    description="SlugBase JSON or a browser bookmark file, up to 5 MiB."
    dropLabel="Drop a file here, or choose one."
    error="This file is larger than 5 MiB."
    fileName="bookmarks.html"
    label="File"
    onFile={() => undefined}
  />
);

export const Disabled = (): React.ReactElement => (
  <FileDrop disabled dropLabel="Drop a file here, or choose one." fileName="bookmarks.html" label="File" onFile={() => undefined} />
);

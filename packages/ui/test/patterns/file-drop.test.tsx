import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileDrop, type FileDropProps } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

function Drop(props: Partial<FileDropProps>): React.ReactElement {
  return <FileDrop description="Up to 5 MiB." dropLabel="Drop a file here, or choose one." label="File" onFile={() => undefined} {...props} />;
}

function fileNamed(name: string): File {
  return new File(["<html></html>"], name, { type: "text/html" });
}

function zone(): HTMLElement {
  const found = document.querySelector<HTMLElement>("[data-slot=file-drop-zone]");
  if (found === null) {
    throw new Error("no drop zone");
  }
  return found;
}

describe("FileDrop", () => {
  it("is a file input named by its label and described by the help and the invitation text", () => {
    render(<Drop accept=".json,.html" />);

    const input = screen.getByLabelText("File");
    expect(input.getAttribute("type")).toBe("file");
    expect(input.getAttribute("accept")).toBe(".json,.html");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("Up to 5 MiB.").id);
    expect(screen.getByText("Drop a file here, or choose one.")).toBeTruthy();
  });

  it("reports a file that is chosen, and lets the same file be chosen again", () => {
    const onFile = vi.fn<(file: File) => void>();
    render(<Drop onFile={onFile} />);
    const input = screen.getByLabelText<HTMLInputElement>("File");
    const file = fileNamed("bookmarks.html");

    fireEvent.change(input, { target: { files: [file] } });

    expect(onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  it("reports the first file that is dropped and marks the zone while a file is dragged over it", () => {
    const onFile = vi.fn<(file: File) => void>();
    render(<Drop onFile={onFile} />);
    const first = fileNamed("first.html");

    fireEvent.dragEnter(zone(), { dataTransfer: { types: ["Files"], files: [first] } });
    expect(zone().getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(zone(), { dataTransfer: { types: ["Files"], files: [first, fileNamed("second.html")] } });

    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(first);
    expect(zone().getAttribute("data-dragging")).toBeNull();
  });

  it("does not mark the zone for a drag that holds no file, such as selected text", () => {
    render(<Drop />);

    fireEvent.dragEnter(zone(), { dataTransfer: { types: ["text/plain"], files: [] } });

    expect(zone().getAttribute("data-dragging")).toBeNull();
  });

  it("takes nothing while it is disabled, by drop or by the picker", () => {
    const onFile = vi.fn<(file: File) => void>();
    render(<Drop disabled onFile={onFile} />);

    fireEvent.drop(zone(), { dataTransfer: { types: ["Files"], files: [fileNamed("a.html")] } });

    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByLabelText("File").hasAttribute("disabled")).toBe(true);
  });

  it("shows the file the page holds as text", () => {
    render(<Drop fileName={'<img src=x onerror="alert(1)">.html'} />);

    expect(screen.getByText('<img src=x onerror="alert(1)">.html')).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("marks the field invalid, describes it by the error and shows the action beside it", () => {
    render(<Drop action={<button type="button">Try again</button>} error="Too large." />);

    const input = screen.getByLabelText("File");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("Too large.").id);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("is free of accessibility violations, with and without an error, in both themes", async () => {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      for (const error of [undefined, "Too large."]) {
        const { container, unmount } = render(<Drop error={error} fileName="bookmarks.html" />);
        await expectNoViolations(container);
        unmount();
      }
    }
  });
});

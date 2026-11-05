import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileDrop, type FileDropProps } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

function Drop(props: Partial<FileDropProps>): React.ReactElement {
  return <FileDrop chooseLabel="Choose file" description="Up to 5 MiB." dropLabel="Drop a file here, or choose one." label="File" noFileLabel="No file chosen" onFile={() => undefined} {...props} />;
}

function fileNamed(name: string): File {
  return new File(["<html></html>"], name, { type: "text/html" });
}

/** The visible button, which is hidden from assistive technology because the file input beside it is the control that is named and reached. */
function chooseButton(): HTMLElement {
  const found = screen.getByText("Choose file").closest("button");
  if (found === null) {
    throw new Error("no choose button");
  }
  return found;
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

  it("shows its own button and its own no-file text instead of the browser's, and the file's name once there is one", () => {
    const { rerender } = render(<Drop />);

    expect(chooseButton()).toBeTruthy();
    expect(screen.getByText("No file chosen")).toBeTruthy();

    rerender(<Drop fileName="bookmarks.html" />);

    expect(screen.queryByText("No file chosen")).toBeNull();
    expect(screen.getByText("bookmarks.html")).toBeTruthy();
  });

  it("opens the file picker from its button, and keeps the input as the one control that is reached by keyboard and named", () => {
    render(<Drop />);
    const input = screen.getByLabelText<HTMLInputElement>("File");
    const open = vi.spyOn(input, "click");

    fireEvent.click(chooseButton());

    expect(open).toHaveBeenCalledTimes(1);
    expect(input.tabIndex).toBe(0);
    expect(chooseButton().getAttribute("tabindex")).toBe("-1");
  });

  it("does not open the picker from its button while it is disabled", () => {
    render(<Drop disabled />);
    const open = vi.spyOn(screen.getByLabelText<HTMLInputElement>("File"), "click");

    fireEvent.click(chooseButton());

    expect(open).not.toHaveBeenCalled();
  });

  it("gives the input to the page's ref, whether it is a function or an object", () => {
    const seen: (HTMLInputElement | null)[] = [];
    const object = { current: null as HTMLInputElement | null };
    const { unmount } = render(<Drop inputRef={(node) => void seen.push(node)} />);
    expect(seen[0]).toBe(screen.getByLabelText("File"));
    unmount();
    render(<Drop inputRef={object} />);
    expect(object.current).toBe(screen.getByLabelText("File"));
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

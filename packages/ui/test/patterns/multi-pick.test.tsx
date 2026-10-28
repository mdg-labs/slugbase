import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MultiPick, type MultiPickProps } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

const OPTIONS = [
  { value: "reading", label: "Reading" },
  { value: "work", label: "Work", description: "Office links" },
  { value: "recipes", label: "Recipes" },
];

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

function chips(): string[] {
  return [...document.querySelectorAll("[data-slot='multi-pick-chip']")].map((chip) => chip.textContent);
}

function removeLabel(label: string): string {
  return `Remove ${label}`;
}

function Pick(props: Partial<MultiPickProps> & { initial?: string[] }): React.ReactElement {
  const { initial = [], onValueChange, ...rest } = props;
  const [value, setValue] = useState<string[]>(initial);
  return (
    <MultiPick
      emptyLabel="Nothing to choose"
      label="Folders"
      onValueChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
      options={OPTIONS}
      removeLabel={removeLabel}
      value={value}
      {...rest}
    />
  );
}

async function open(): Promise<HTMLElement> {
  const input = screen.getByRole("combobox", { name: "Folders" });
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  return input;
}

async function typeInto(input: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
    await Promise.resolve();
  });
}

describe("MultiPick", () => {
  it("is free of accessibility violations once a chip is taken off", async () => {
    const { container } = render(<Pick initial={["reading", "work"]} />);
    await act(async () => {
      fireEvent.click(container.querySelector(`[aria-label="${removeLabel("Reading")}"]`) as HTMLElement);
      await Promise.resolve();
    });

    expect(chips()).toEqual(["Work"]);
    await expectNoViolations(container);
  });

  it("is a combobox named by its label that shows each chosen option as a chip with a button that takes it off", async () => {
    const onValueChange = vi.fn<(value: string[]) => void>();
    render(<Pick initial={["reading", "work"]} onValueChange={onValueChange} />);

    expect(screen.getByText("Reading")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Reading" }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenLastCalledWith(["work"]);
    expect(screen.queryByText("Reading")).toBeNull();
  });

  it("lists the options, adds the one that is chosen to the chips and keeps the others", async () => {
    const onValueChange = vi.fn<(value: string[]) => void>();
    render(<Pick initial={["reading"]} onValueChange={onValueChange} />);

    await open();
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: /Recipes/ }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenLastCalledWith(["reading", "recipes"]);
  });

  it("narrows the list by what is typed, label or description, and says when nothing matches", async () => {
    render(<Pick />);
    const input = await open();

    await typeInto(input, "office");
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["WorkOffice links"]);

    await typeInto(input, "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nothing to choose")).toBeTruthy();
  });

  it("offers to create a text no option carries, hands the trimmed text to the caller, and selects nothing itself", async () => {
    const onCreate = vi.fn<(name: string) => void>();
    const onValueChange = vi.fn<(value: string[]) => void>();
    render(<Pick creatable={{ label: (name) => `Create folder “${name}”`, onCreate }} onValueChange={onValueChange} />);
    const input = await open();

    await typeInto(input, "  Travel ");
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: "Create folder “Travel”" }));
      await Promise.resolve();
    });

    expect(onCreate).toHaveBeenCalledExactlyOnceWith("Travel");
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Folders" }).value).toBe("");
  });

  it("does not offer to create a text that an option carries, in any case", async () => {
    render(<Pick creatable={{ label: (name) => `Create folder “${name}”`, onCreate: () => undefined }} />);
    const input = await open();

    await typeInto(input, "reading");

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Reading"]);
  });

  it("says the options are loading, or could not be read, and not that there are none", async () => {
    const { rerender } = render(<Pick loadingLabel="Loading folders" options={[]} />);
    await open();
    expect((await screen.findByText("Loading folders")).getAttribute("data-slot")).toBe("multi-pick-loading");
    expect(screen.queryByText("Nothing to choose")).toBeNull();

    rerender(<Pick options={[]} unavailableLabel="The folders could not be loaded" />);
    expect((await screen.findByRole("alert")).textContent).toBe("The folders could not be loaded");
    expect(screen.queryByText("Nothing to choose")).toBeNull();
  });

  it("keeps the chips when Escape is pressed, and leaves an Escape with the list shut to the overlay around it", async () => {
    const onOutside = vi.fn<(key: string) => void>();
    render(
      <div onKeyDown={(event) => { onOutside(event.key); }}>
        <Pick initial={["reading", "work"]} />
      </div>,
    );
    const input = await open();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
    expect(chips()).toEqual(["Reading", "Work"]);
    await waitFor(() => {
      expect(document.querySelector("[data-slot='multi-pick-popup']")).toBeNull();
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });

    expect(chips()).toEqual(["Reading", "Work"]);
    expect(onOutside).toHaveBeenLastCalledWith("Escape");
  });

  it("says there are none once the options were read and are none", async () => {
    render(<Pick options={[]} />);
    await open();

    expect(await screen.findByText("Nothing to choose")).toBeTruthy();
  });

  it("marks the field invalid and describes it by the error", async () => {
    const { container } = render(<Pick error="Use at most 40 characters." />);

    expect(screen.getByRole("combobox", { name: "Folders" }).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Use at most 40 characters.")).toBeTruthy();
    await expectNoViolations(container);
  });
});

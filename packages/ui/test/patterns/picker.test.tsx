import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Picker } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

const OPTIONS = [
  { value: "ada", label: "Ada Lovelace", description: "ada@example.org" },
  { value: "grace", label: "Grace Hopper", description: "grace@example.org" },
  { value: "hedy", label: "Hedy Lamarr", description: "hedy@example.org" },
];

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
});

async function open(): Promise<void> {
  await act(async () => {
    const input = screen.getByRole("combobox", { name: "Recipient" });
    // Base UI opens the list on a press that began on the input.
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
}

describe("Picker", () => {
  it("is a combobox named by its label that shows the chosen option", async () => {
    const { container } = render(<Picker emptyLabel="Nobody matches" label="Recipient" onValueChange={() => undefined} options={OPTIONS} value="grace" />);

    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Recipient" }).value).toBe("Grace Hopper");
    await expectNoViolations(container);
  });

  it("lists the options with their descriptions and reports the one that is chosen", async () => {
    const onValueChange = vi.fn<(value: string) => void>();
    render(<Picker emptyLabel="Nobody matches" label="Recipient" onValueChange={onValueChange} options={OPTIONS} value="ada" />);

    await open();
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Ada Lovelaceada@example.org", "Grace Hoppergrace@example.org", "Hedy Lamarrhedy@example.org"]);
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: /Hedy Lamarr/ }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("hedy");
  });

  it("narrows the list by what is typed, name or description, and says when nothing matches", async () => {
    render(<Picker emptyLabel="Nobody matches" label="Recipient" onValueChange={() => undefined} options={OPTIONS} value={undefined} />);
    await open();
    const input = screen.getByRole("combobox", { name: "Recipient" });

    await act(async () => {
      fireEvent.change(input, { target: { value: "grace@" } });
      await Promise.resolve();
    });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Grace Hoppergrace@example.org"]);

    await act(async () => {
      fireEvent.change(input, { target: { value: "zzz" } });
      await Promise.resolve();
    });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nobody matches")).toBeTruthy();
  });

  it("marks the field invalid and describes it by the error", async () => {
    const { container } = render(<Picker emptyLabel="Nobody" error="Choose a recipient." label="Recipient" onValueChange={() => undefined} options={OPTIONS} value={undefined} />);

    expect(screen.getByRole("combobox", { name: "Recipient" }).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Choose a recipient.")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("draws an option's icon in the list and in the field once the option is chosen, as decoration", async () => {
    const options = [
      { value: "star", label: "Star", icon: <svg data-testid="star-icon" /> },
      { value: "moon", label: "Moon" },
    ];
    const { rerender } = render(<Picker emptyLabel="Nothing" label="Icon" onValueChange={() => undefined} options={options} value="moon" />);
    expect(screen.queryByTestId("star-icon")).toBeNull();

    rerender(<Picker emptyLabel="Nothing" label="Icon" onValueChange={() => undefined} options={options} value="star" />);

    expect(screen.getByTestId("star-icon").closest("[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Icon" }).className).toContain("ps-9");
    await act(async () => {
      const input = screen.getByRole("combobox", { name: "Icon" });
      fireEvent.pointerDown(input);
      fireEvent.mouseDown(input);
      fireEvent.click(input);
      await Promise.resolve();
    });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Star", "Moon"]);
    expect(screen.getAllByTestId("star-icon")).toHaveLength(2);
  });
});

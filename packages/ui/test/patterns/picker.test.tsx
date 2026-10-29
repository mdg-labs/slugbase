import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Picker } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

const OPTIONS = [
  { value: "ada", label: "Ada Lovelace", description: "ada@example.org" },
  { value: "grace", label: "Grace Hopper", description: "grace@example.org" },
  { value: "hedy", label: "Hedy Lamarr", description: "hedy@example.org" },
];

const GROUPED = [
  { value: "ada", label: "Ada Lovelace", description: "ada@example.org", group: "Members" },
  { value: "platform", label: "Platform", group: "Teams" },
  { value: "grace", label: "Grace Hopper", description: "grace@example.org", group: "Members" },
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
  it("is a combobox named by its label that shows the chosen option", () => {
    render(<Picker emptyLabel="Nobody matches" label="Recipient" onValueChange={() => undefined} options={OPTIONS} value="grace" />);

    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Recipient" }).value).toBe("Grace Hopper");
  });

  it("is free of accessibility violations", async () => {
    const { container } = render(<Picker emptyLabel="Nobody matches" label="Recipient" onValueChange={() => undefined} options={OPTIONS} value="grace" />);

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

  it("says the options are loading, or could not be read, and not that there are none", async () => {
    const { rerender } = render(<Picker emptyLabel="Nobody" label="Recipient" loadingLabel="Loading members" onValueChange={() => undefined} options={[]} value={undefined} />);
    await open();
    expect((await screen.findByText("Loading members")).getAttribute("data-slot")).toBe("picker-loading");
    expect(screen.queryByText("Nobody")).toBeNull();

    rerender(<Picker emptyLabel="Nobody" label="Recipient" onValueChange={() => undefined} options={[]} unavailableLabel="The members could not be loaded" value={undefined} />);
    const failed = await screen.findByText("The members could not be loaded");
    expect(failed.getAttribute("data-slot")).toBe("picker-unavailable");
    expect(failed.getAttribute("role")).toBe("alert");
    expect(screen.queryByText("Nobody")).toBeNull();
  });
  it("lists options under their group headings, narrows each group by what is typed and drops a group with no match", async () => {
    const grouped = GROUPED;
    const onValueChange = vi.fn<(value: string) => void>();
    render(<Picker emptyLabel="Nobody matches" label="Recipient" onValueChange={onValueChange} options={grouped} value={undefined} />);
    await open();

    expect(await screen.findByText("Members")).toBeTruthy();
    expect(screen.getByText("Teams")).toBeTruthy();
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Ada Lovelaceada@example.org", "Grace Hoppergrace@example.org", "Platform"]);

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Recipient" }), { target: { value: "plat" } });
      await Promise.resolve();
    });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Platform"]);
    expect(screen.queryByText("Members")).toBeNull();

    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: /Platform/ }));
      await Promise.resolve();
    });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("platform");
  });
  it("reports the text typed in the input", async () => {
    const onSearchChange = vi.fn<(text: string) => void>();
    render(<Picker emptyLabel="Nobody matches" label="Recipient" onSearchChange={onSearchChange} onValueChange={() => undefined} options={OPTIONS} value={undefined} />);
    await open();

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Recipient" }), { target: { value: "gra" } });
      await Promise.resolve();
    });

    expect(onSearchChange).toHaveBeenLastCalledWith("gra");
  });
  it("keeps what was typed when the caller renders again with the same options", async () => {
    function Host(): React.ReactElement {
      const [text, setText] = useState("");
      return (
        <>
          <Picker emptyLabel="Nobody matches" label="Recipient" onSearchChange={setText} onValueChange={() => undefined} options={GROUPED} value={undefined} />
          <output>{text}</output>
        </>
      );
    }
    render(<Host />);
    await open();

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Recipient" }), { target: { value: "plat" } });
      await Promise.resolve();
    });

    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Recipient" }).value).toBe("plat");
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Platform"]);
  });
});

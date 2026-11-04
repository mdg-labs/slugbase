import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATE_RANGE_MAX_DAY, DATE_RANGE_MIN_DAY, DateRange, isCalendarDay, type DateRangeDays } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

const PRESETS = [
  { value: "any", label: "Any time" },
  { value: "7d", label: "Last 7 days" },
  { value: "custom", label: "Custom range" },
];

beforeEach(() => {
  stubBrowserApis();
});

function Harness({
  preset = "custom",
  initial = { first: "", last: "" },
  onDaysChange,
  error,
}: {
  preset?: string;
  initial?: DateRangeDays;
  onDaysChange?: (days: DateRangeDays) => void;
  error?: string;
}): React.ReactElement {
  const [chosen, setChosen] = useState(preset);
  const [days, setDays] = useState(initial);
  return (
    <DateRange
      boundsError="Enter a day from year 0001 to 9999."
      customPreset="custom"
      days={days}
      error={error}
      firstLabel="First day"
      label="Date range"
      lastLabel="Last day"
      onDaysChange={(next) => {
        setDays(next);
        onDaysChange?.(next);
      }}
      onPresetChange={setChosen}
      orderError="The last day is before the first day."
      preset={chosen}
      presets={PRESETS}
    />
  );
}

async function enter(label: string, value: string): Promise<HTMLInputElement> {
  const input = screen.getByLabelText<HTMLInputElement>(label);
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    await Promise.resolve();
  });
  return input;
}

describe("isCalendarDay", () => {
  it("takes the days of the calendar from year 0001 to 9999 and nothing else", () => {
    expect(isCalendarDay("2026-02-28")).toBe(true);
    expect(isCalendarDay("2024-02-29")).toBe(true);
    expect(isCalendarDay("0001-01-01")).toBe(true);
    expect(isCalendarDay("9999-12-31")).toBe(true);
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay("1900-02-29")).toBe(false);
    expect(isCalendarDay("2000-02-29")).toBe(true);
    expect(isCalendarDay("2026-04-31")).toBe(false);
    expect(isCalendarDay("2026-13-01")).toBe(false);
    expect(isCalendarDay("2026-00-10")).toBe(false);
    expect(isCalendarDay("0000-05-01")).toBe(false);
    expect(isCalendarDay("10000-01-01")).toBe(false);
    expect(isCalendarDay("2026-1-1")).toBe(false);
    expect(isCalendarDay("")).toBe(false);
  });
});

describe("DateRange", () => {
  it("names the select and the two day fields, and bounds the inputs to years 0001 to 9999", async () => {
    const { container } = render(<Harness initial={{ first: "2026-10-01", last: "2026-10-15" }} />);

    expect(screen.getByRole("combobox", { name: "Date range" }).textContent).toContain("Custom range");
    const first = screen.getByLabelText<HTMLInputElement>("First day");
    const last = screen.getByLabelText<HTMLInputElement>("Last day");
    expect(first.type).toBe("date");
    expect(first.value).toBe("2026-10-01");
    expect(last.value).toBe("2026-10-15");
    for (const input of [first, last]) {
      expect(input.min).toBe(DATE_RANGE_MIN_DAY);
      expect(input.max).toBe(DATE_RANGE_MAX_DAY);
    }
    await expectNoViolations(container);
  });

  it("shows the day fields only for the custom preset", () => {
    render(<Harness preset="7d" />);

    expect(screen.queryByLabelText("First day")).toBeNull();
    expect(screen.queryByLabelText("Last day")).toBeNull();
  });

  it("reports the preset the member chooses, and shows the day fields once the custom one is chosen", async () => {
    render(<Harness preset="any" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Date range" }));
      await Promise.resolve();
    });
    await act(async () => {
      const option = await screen.findByRole("option", { name: "Custom range" });
      // Base UI commits a click only after the press began on the item.
      fireEvent.pointerDown(option);
      fireEvent.click(option);
      await Promise.resolve();
    });

    expect(screen.getByLabelText("First day")).toBeTruthy();
    expect(screen.getByLabelText("Last day")).toBeTruthy();
  });

  it("reports a range of days that passes, and an open end", async () => {
    const onDaysChange = vi.fn<(days: DateRangeDays) => void>();
    render(<Harness onDaysChange={onDaysChange} />);

    await enter("First day", "2026-10-01");
    expect(onDaysChange).toHaveBeenLastCalledWith({ first: "2026-10-01", last: "" });
    await enter("Last day", "2026-10-01");
    expect(onDaysChange).toHaveBeenLastCalledWith({ first: "2026-10-01", last: "2026-10-01" });
    await enter("First day", "");
    expect(onDaysChange).toHaveBeenLastCalledWith({ first: "", last: "2026-10-01" });
    expect(onDaysChange).toHaveBeenCalledTimes(3);
  });

  it("says a first day after the last under the last day, reports nothing, and clears the message once it is put right", async () => {
    const onDaysChange = vi.fn<(days: DateRangeDays) => void>();
    const { container } = render(<Harness initial={{ first: "2026-10-01", last: "2026-10-15" }} onDaysChange={onDaysChange} />);

    const first = await enter("First day", "2026-10-20");

    expect(onDaysChange).not.toHaveBeenCalled();
    expect(first.value).toBe("2026-10-20");
    const last = screen.getByLabelText("Last day");
    expect(last.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("The last day is before the first day.")).toBeTruthy();
    expect(last.getAttribute("aria-describedby")).toContain(screen.getByText("The last day is before the first day.").id);
    await expectNoViolations(container);

    await enter("Last day", "2026-10-25");

    expect(onDaysChange).toHaveBeenCalledExactlyOnceWith({ first: "2026-10-20", last: "2026-10-25" });
    expect(screen.queryByText("The last day is before the first day.")).toBeNull();
  });

  it("refuses a day outside years 0001 to 9999 on the field it is in, and reports nothing", async () => {
    const onDaysChange = vi.fn<(days: DateRangeDays) => void>();
    render(<Harness initial={{ first: "2026-10-01", last: "2026-10-15" }} onDaysChange={onDaysChange} />);

    await enter("Last day", "10000-01-01");

    expect(onDaysChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Last day").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("First day").getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText("Enter a day from year 0001 to 9999.")).toBeTruthy();
  });

  it("takes the days of the caller over what was typed when they change", async () => {
    function Resetting(): React.ReactElement {
      const [days, setDays] = useState<DateRangeDays>({ first: "2026-10-01", last: "2026-10-15" });
      return (
        <>
          <button
            onClick={() => {
              setDays({ first: "", last: "" });
            }}
            type="button"
          >
            Reset
          </button>
          <DateRange
            boundsError="bounds"
            customPreset="custom"
            days={days}
            firstLabel="First day"
            label="Date range"
            lastLabel="Last day"
            onDaysChange={setDays}
            onPresetChange={() => undefined}
            orderError="order"
            preset="custom"
            presets={PRESETS}
          />
        </>
      );
    }
    render(<Resetting />);
    await enter("First day", "2026-11-01");
    expect(screen.getByText("order")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
      await Promise.resolve();
    });

    expect(screen.getByLabelText<HTMLInputElement>("First day").value).toBe("");
    expect(screen.queryByText("order")).toBeNull();
  });

  it("shows the reason the days are refused elsewhere under the last day", async () => {
    const { container } = render(<Harness error="This range could not be used." initial={{ first: "2026-10-01", last: "2026-10-15" }} />);

    expect(screen.getByText("This range could not be used.")).toBeTruthy();
    expect(screen.getByLabelText("Last day").getAttribute("aria-invalid")).toBe("true");
    await expectNoViolations(container);
  });
});

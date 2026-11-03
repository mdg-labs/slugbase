import { describe, expect, it } from "vitest";
import { earliestDay } from "../src/shell/admin-access-mode-dialog.tsx";

// The first day the admin's date input offers for an export-only period (doc 03 section 12). The period ends at 23:59 local time on the chosen
// day and the server refuses an end less than a day ahead, so the day offered must always end a day or more from now: a day chosen in the
// last minutes of today that ended 23 hours and 59 minutes ahead would be refused with `until_too_soon`.

const DAY_MS = 24 * 60 * 60 * 1000;

function endOf(day: string): number {
  return new Date(`${day}T23:59:00`).getTime();
}

describe("the earliest day offered for an export-only period", () => {
  it("is tomorrow in the middle of the day", () => {
    expect(earliestDay(new Date(2099, 0, 14, 12, 0, 0))).toBe("2099-01-15");
  });

  it("is the day after tomorrow in the last minute of the day, when tomorrow ends less than a day ahead", () => {
    const now = new Date(2099, 0, 14, 23, 59, 30);
    expect(endOf("2099-01-15") - now.getTime()).toBeLessThan(DAY_MS);
    expect(earliestDay(now)).toBe("2099-01-16");
  });

  it("always ends a day or more ahead, at every minute of a day", () => {
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const now = new Date(2099, 2, 28, 0, minute, 30);
      expect(endOf(earliestDay(now)) - now.getTime(), now.toISOString()).toBeGreaterThanOrEqual(DAY_MS);
    }
  });
});

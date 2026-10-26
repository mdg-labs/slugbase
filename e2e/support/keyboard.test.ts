import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tabTo, waitForInitialFocus, type FocusTarget, type KeyboardPage } from "./keyboard.ts";

// A page of 25 fields in a ring, the first the field a dialog moves the focus to and the second the field after it,
// the way the New bookmark dialog of the journeys has the URL and the title ahead of 23 more stops (the dialog's own and
// the page behind it on WebKit's first cycle). The dialog moves the focus to the first field `delay` milliseconds after
// it opens. A Tab pressed before then starts the focus on its own way (the second field), and the dialog, which does not
// take the focus from a user who has begun to move it, leaves it there: the first field is then a whole cycle away.
const STOPS = 25;

function openDialog(delay: number): { page: KeyboardPage; fields: FocusTarget[]; presses: () => number } {
  let focused: number | null = null;
  let moved = false;
  let presses = 0;
  const timer = setTimeout(() => {
    if (!moved) {
      focused = 0;
    }
  }, delay);
  timer.unref();
  const page: KeyboardPage = {
    keyboard: {
      press: (key) => {
        assert.equal(key, "Tab");
        presses++;
        moved = true;
        focused = focused === null ? 1 : (focused + 1) % STOPS;
        return Promise.resolve();
      },
    },
  };
  const fields = Array.from({ length: STOPS }, (_, index): FocusTarget => ({ evaluate: () => Promise.resolve(focused === index) }));
  return { page, fields, presses: () => presses };
}

void describe("the keyboard steps of the journeys", () => {
  void it("tab to a field that takes the focus on a timer fails when Tab is pressed before the timer", async () => {
    const { page, fields } = openDialog(60);
    const [url, title] = fields;
    assert.ok(url !== undefined && title !== undefined);
    await assert.rejects(tabTo(page, url), /Tab reaches the element within 20 presses/);
  });

  void it("tab to a field that takes the focus on a timer passes after the wait for that focus", async () => {
    const { page, fields, presses } = openDialog(60);
    const [url, title] = fields;
    assert.ok(url !== undefined && title !== undefined);
    await waitForInitialFocus(url, "the URL field");
    await tabTo(page, url);
    assert.equal(presses(), 0, "the field already holds the focus, so no key is pressed");
    await tabTo(page, title);
    assert.equal(presses(), 1);
  });

  void it("tab stays within its budget of presses", async () => {
    const { page, fields } = openDialog(0);
    const last = fields[STOPS - 1];
    assert.ok(last !== undefined);
    await waitForInitialFocus(fields[0] as FocusTarget, "the first field");
    await assert.rejects(tabTo(page, last), /within 20 presses/);
  });

  void it("the wait gives up with the field it waited for when the focus never arrives", async () => {
    const { fields } = openDialog(60_000);
    const [url] = fields;
    assert.ok(url !== undefined);
    await assert.rejects(waitForInitialFocus(url, "the URL field", 100), /the URL field has the initial focus within 100 ms/);
  });
});

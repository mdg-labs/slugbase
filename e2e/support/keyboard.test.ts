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

  // A locator of a field that never mounts waits for it until the timeout it is given, or until the test's own timeout
  // when it is given none; this one waits for ever without one.
  void it("the wait bounds the wait for an element that never exists by its own deadline", { timeout: 2000 }, async () => {
    const timeouts: number[] = [];
    const missing: FocusTarget = {
      evaluate: (_pageFunction, _arg, options) => {
        const timeout = options?.timeout;
        if (timeout === undefined) {
          return new Promise<boolean>(() => undefined);
        }
        timeouts.push(timeout);
        return new Promise<boolean>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("locator.evaluate: Timeout"));
          }, timeout);
        });
      },
    };
    await assert.rejects(waitForInitialFocus(missing, "the URL field", 100), /the URL field has the initial focus within 100 ms/);
    assert.ok(timeouts.length > 0 && timeouts.every((timeout) => timeout > 0 && timeout <= 100), `timeouts ${timeouts.join(", ")}`);
  });

  // A timer can fire before the wall clock reaches the deadline it was set for: here the lookup rejects once its timeout
  // has run out while `Date.now()` still reads a millisecond short of the deadline.
  void it("the wait reports a lookup whose timeout ran out as the missed focus while the wall clock is a millisecond short", async (context) => {
    const wallClock = Date.now.bind(Date);
    let skew = 0;
    context.mock.method(Date, "now", () => wallClock() - skew);
    const missing: FocusTarget = {
      evaluate: (_pageFunction, _arg, options) => {
        skew = 1;
        return new Promise<boolean>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("locator.evaluate: Timeout"));
          }, options?.timeout);
        });
      },
    };
    const failure = await waitForInitialFocus(missing, "the URL field", 100).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /the URL field has the initial focus within 100 ms/);
    assert.match((failure.cause as Error).message, /locator\.evaluate: Timeout/);
  });

  void it("the wait reports a TimeoutError of the lookup as the missed focus", async () => {
    const timedOut = new Error("locator.evaluate: Timeout 100ms exceeded.");
    timedOut.name = "TimeoutError";
    const missing: FocusTarget = { evaluate: () => Promise.reject(timedOut) };
    const failure = await waitForInitialFocus(missing, "the URL field", 100).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /the URL field has the initial focus within 100 ms/);
    assert.equal(failure.cause, timedOut);
  });

  void it("the wait rethrows a lookup error that is not its timeout as it is", async () => {
    const broken = new Error("locator.evaluate: Target closed");
    const target: FocusTarget = { evaluate: () => Promise.reject(broken) };
    await assert.rejects(waitForInitialFocus(target, "the URL field", 100), (error: unknown) => error === broken);
  });

  // A lookup that fails for another reason just as the timeout it was given runs out is not that timeout.
  void it("the wait rethrows a lookup error that is not its timeout as it is when it arrives as the timeout runs out", async () => {
    const broken = new Error("locator.evaluate: Target closed");
    const target: FocusTarget = {
      evaluate: (_pageFunction, _arg, options) =>
        new Promise<boolean>((_resolve, reject) => {
          setTimeout(() => {
            reject(broken);
          }, options?.timeout);
        }),
    };
    await assert.rejects(waitForInitialFocus(target, "the URL field", 100), (error: unknown) => error === broken);
  });
});

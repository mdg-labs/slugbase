import { randomBytes } from "node:crypto";
import type { Locator, Page, Route } from "@playwright/test";
import { message } from "../support/catalog.ts";
import { expectHighlighted, openPaletteWithShortcut, paletteDialog, paletteInput } from "../support/palette.ts";
import { expect, test } from "../support/test.ts";

// Where the focus is in the bookmark modal when the Suggest action or one of its chips goes, and what the keys do behind the modal (doc 03
// sections 4 and 14, doc 08 section 5.2). Focus behaves differently in each engine when the element that holds it leaves the page: in
// Firefox and WebKit it falls to the page behind the dialog, where a single key such as `?` would act; Chromium lands on the dialog. So
// the journeys run in the three engines and press the keys as a member does. The provider's answers are made by the page's own route
// handlers (the server is not asked), and a save that the page sends is answered with a refusal after a pause, so nothing is made and
// the stand-in for the provider (tests/ai.spec.ts counts what it received) is not asked.

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

const SUGGESTIONS = "**/api/v1/ai/suggestions";
const BOOKMARKS = "**/api/v1/bookmarks";
const WORKSPACE = "**/api/v1/workspace";

function refuse(route: Route, status: number, code: string): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({ type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "refused on purpose", requestId: "e2e-focus" }),
  });
}

/** Lets React render what a key press changed. */
async function afterRender(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

test.describe("focus in the bookmark modal", () => {
  const token = randomBytes(4).toString("hex");
  const address = `https://focus-${token}.invalid/page`;

  function modal(page: Page): { dialog: Locator; suggest: Locator; sheet: Locator; field: (key: string) => Locator; group: (key: string) => Locator } {
    const dialog = page.getByRole("dialog", { name: en("bookmarks.modal.create.title"), exact: true });
    return {
      dialog,
      suggest: dialog.getByRole("button", { name: en("bookmarks.modal.suggest.label"), exact: true }),
      sheet: page.getByRole("dialog", { name: en("shortcuts.title"), exact: true }),
      field: (key) => dialog.getByLabel(en(key), { exact: true }),
      group: (key) => dialog.getByRole("group", { name: en(key), exact: true }),
    };
  }

  /** Whether the focus is inside the dialog, which is what keeps `?` and the other single keys from acting on the page behind it. */
  async function focusInside(dialog: Locator): Promise<boolean> {
    return dialog.evaluate((root) => root.contains(document.activeElement) && document.activeElement !== document.body);
  }

  async function open(page: Page, app: { visit: (path: string, ready: Locator) => Promise<void> }): Promise<ReturnType<typeof modal>> {
    const parts = modal(page);
    await app.visit("/bookmarks?new=1", parts.dialog);
    await expect(parts.suggest).toBeVisible();
    return parts;
  }

  for (const [name, status, code] of [
    ["the API refuses it because the workspace turned suggestions off", 403, "forbidden"],
    ["the API refuses it because the instance lost its adapter", 503, "ai_unavailable"],
  ] as const) {
    test(`keeps the focus in the dialog when ${name}`, async ({ page, app, account }) => {
      await account.set({ locale: "en" });
      await page.route(SUGGESTIONS, (route) => refuse(route, status, code));
      const { dialog, suggest, sheet, field } = await open(page, app);
      await field("bookmarks.modal.url.label").fill(address);

      await suggest.focus();
      await page.keyboard.press("Enter");

      await expect(dialog.getByText(en("bookmarks.modal.suggest.unavailable"), { exact: true })).toBeVisible();
      await expect(suggest).toHaveCount(0);
      expect(await focusInside(dialog), "the focus is inside the dialog").toBe(true);
      await page.keyboard.press("?");
      await afterRender(page);
      await expect(sheet).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await app.scan();
    });
  }

  test("keeps the focus in the dialog when a read turns the toggle off while the action holds it", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    let off = false;
    await page.route(WORKSPACE, async (route) => {
      if (!off || route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, aiEnabled: false } });
    });
    const { dialog, suggest, sheet } = await open(page, app);

    await suggest.focus();
    off = true;
    // The window regains focus: the page reads the workspace again.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(suggest).toHaveCount(0);
    expect(await focusInside(dialog), "the focus is inside the dialog").toBe(true);
    await page.keyboard.press("?");
    await afterRender(page);
    await expect(sheet).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await app.scan();
  });

  /**
   * Makes the page read the workspace with the toggle off once `turnOff` is called: the window regains focus, the page reads the workspace
   * again, and the Suggest action goes. It resolves when the page has taken the answer and rendered it.
   */
  async function toggleTurnedOffElsewhere(page: Page): Promise<() => Promise<void>> {
    let off = false;
    await page.route(WORKSPACE, async (route) => {
      if (!off || route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, aiEnabled: false } });
    });
    return async () => {
      off = true;
      const read = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/workspace" && response.request().method() === "GET");
      await page.evaluate(() => {
        window.dispatchEvent(new Event("visibilitychange"));
      });
      await read;
      await afterRender(page);
    };
  }

  /** The Suggest action wherever it is in the page, including in a dialog that another overlay has hidden from the accessibility tree. */
  function suggestAnywhere(page: Page): Locator {
    return page.locator("[role='dialog'] button").filter({ hasText: new RegExp(`^${en("bookmarks.modal.suggest.label")}$`) });
  }

  test("leaves the focus in the discard question when the action goes while that question stands over the form", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    const turnOff = await toggleTurnedOffElsewhere(page);
    const { dialog, field } = await open(page, app);
    await field("bookmarks.modal.title.label").fill(`Typed ${token}`);

    await page.keyboard.press("Escape");
    const guard = page.getByRole("alertdialog", { name: en("bookmarks.modal.unsaved.title"), exact: true });
    const keep = guard.getByRole("button", { name: en("bookmarks.modal.unsaved.keepEditing"), exact: true });
    await expect(keep).toBeFocused();

    await turnOff();

    await expect(suggestAnywhere(page)).toHaveCount(0);
    await expect(keep).toBeFocused();
    // The question can still be answered from the keyboard.
    await page.keyboard.press("Enter");
    await expect(guard).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(field("bookmarks.modal.title.label")).toHaveValue(`Typed ${token}`);
    await app.scan();
  });

  test("leaves the focus in the palette when the action goes while the palette stands over the form", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    const turnOff = await toggleTurnedOffElsewhere(page);
    const { dialog } = await open(page, app);

    await openPaletteWithShortcut(page);
    await turnOff();

    await expect(suggestAnywhere(page)).toHaveCount(0);
    await expect(paletteInput(page)).toBeFocused();
    // What is typed goes to the palette, and Esc closes the palette and not the form under it.
    await page.keyboard.type(`find-${token}`);
    await expect(paletteInput(page)).toHaveValue(`find-${token}`);
    await page.keyboard.press("Escape");
    await expect(paletteDialog(page)).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await app.scan();
  });

  // Where the focus goes when an overlay that stood over the form closes after the action went. The element that had the focus when the
  // overlay opened is the action, and it is gone, so the focus ends inside the form's dialog and not on the page behind it, where Tab would
  // go on through the page (Chromium) or a single key would act. The action goes by a refusal of a run that is under way or by a read.
  type Withdrawal = "refusal" | "read";

  /**
   * Prepares the page for the action to be withdrawn, and returns what starts the withdrawal's cause (`start`, to run while the action holds
   * the focus) and what makes the action go (`withdraw`, which resolves when the page has rendered its absence).
   */
  async function prepareWithdrawal(page: Page, how: Withdrawal): Promise<{ start: () => Promise<void>; withdraw: () => Promise<void> }> {
    if (how === "read") {
      return { start: () => Promise.resolve(), withdraw: await toggleTurnedOffElsewhere(page) };
    }
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(SUGGESTIONS, async (route) => {
      await gate;
      await refuse(route, 403, "forbidden");
    });
    return {
      start: async () => {
        await page.keyboard.press("Enter");
      },
      withdraw: async () => {
        release();
        await expect(suggestAnywhere(page)).toHaveCount(0);
        await afterRender(page);
      },
    };
  }

  /** Presses Escape until the discard question stands: the first press closes the tooltip that the focus on the action opened. */
  async function askToDiscard(page: Page): Promise<{ guard: Locator; keep: Locator }> {
    const guard = page.getByRole("alertdialog", { name: en("bookmarks.modal.unsaved.title"), exact: true });
    for (let attempt = 0; attempt < 3 && (await guard.count()) === 0; attempt += 1) {
      await page.keyboard.press("Escape");
      await afterRender(page);
    }
    const keep = guard.getByRole("button", { name: en("bookmarks.modal.unsaved.keepEditing"), exact: true });
    await expect(keep).toBeFocused();
    return { guard, keep };
  }

  /** Walks the whole tab order both ways: the focus never leaves the dialog. */
  async function expectTabStaysInside(page: Page, dialog: Locator): Promise<void> {
    for (const direction of ["Tab", "Shift+Tab"]) {
      for (let step = 0; step < 30; step += 1) {
        await page.keyboard.press(direction);
        expect(await focusInside(dialog), `the focus is inside the dialog after ${direction} (${String(step + 1)})`).toBe(true);
      }
    }
  }

  for (const how of ["refusal", "read"] as const) {
    test(`ends inside the dialog when the discard question closes after the action went by a ${how}`, async ({ page, app, account }) => {
      await account.set({ locale: "en" });
      const { start, withdraw } = await prepareWithdrawal(page, how);
      const { dialog, suggest, sheet, field } = await open(page, app);
      await field("bookmarks.modal.url.label").fill(address);
      await field("bookmarks.modal.title.label").fill(`Typed ${token}`);
      await suggest.focus();
      await start();

      const { guard, keep } = await askToDiscard(page);
      await withdraw();
      await expect(keep).toBeFocused();
      await keep.press("Enter");

      await expect(guard).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(field("bookmarks.modal.title.label")).toHaveValue(`Typed ${token}`);
      await expect.poll(() => focusInside(dialog), { message: "the focus is inside the dialog" }).toBe(true);
      await expectTabStaysInside(page, dialog);
      await page.keyboard.press("?");
      await afterRender(page);
      await expect(sheet).toHaveCount(0);
      await app.scan();
    });

    test(`ends inside the dialog when the palette closes after the action went by a ${how}`, async ({ page, app, account }) => {
      await account.set({ locale: "en" });
      const { start, withdraw } = await prepareWithdrawal(page, how);
      const { dialog, suggest, sheet, field } = await open(page, app);
      await field("bookmarks.modal.url.label").fill(address);
      await suggest.focus();
      await start();

      await openPaletteWithShortcut(page);
      await withdraw();
      await expect(paletteInput(page)).toBeFocused();
      await page.keyboard.press("Escape");

      await expect(paletteDialog(page)).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect.poll(() => focusInside(dialog), { message: "the focus is inside the dialog" }).toBe(true);
      await expectTabStaysInside(page, dialog);
      await page.keyboard.press("?");
      await afterRender(page);
      await expect(sheet).toHaveCount(0);
      await app.scan();
    });
  }

  test("ends inside the dialog when the action goes just as the discard question closes", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    const withdraw = await toggleTurnedOffElsewhere(page);
    const { dialog, suggest, field } = await open(page, app);
    await field("bookmarks.modal.title.label").fill(`Typed ${token}`);
    await suggest.focus();

    const { guard, keep } = await askToDiscard(page);
    await Promise.all([keep.press("Enter"), withdraw()]);

    await expect(guard).toHaveCount(0);
    await expect(suggestAnywhere(page)).toHaveCount(0);
    await expect.poll(() => focusInside(dialog), { message: "the focus is inside the dialog" }).toBe(true);
    await expectTabStaysInside(page, dialog);
  });

  test("gives the focus back to the field it came from when the palette closes and the action is still there", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    const { dialog, suggest, field } = await open(page, app);
    const title = field("bookmarks.modal.title.label");
    await title.focus();

    await openPaletteWithShortcut(page);
    await page.keyboard.press("Escape");

    await expect(paletteDialog(page)).toHaveCount(0);
    await expect(title).toBeFocused();
    await expect(suggest).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  // A toast is a dialog that says `aria-modal="false"` and takes no focus from the page. It does not own the focus when the palette closes: with
  // no form open the focus goes back to the palette's trigger, and `?` works afterwards.
  test("gives the focus back to the palette's trigger, not to the toast that a save left standing", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    const { dialog, field, sheet } = await open(page, app);
    await field("bookmarks.modal.url.label").fill(address);
    await field("bookmarks.modal.title.label").fill(`Saved ${token}`);
    await field("bookmarks.modal.title.label").focus();
    await page.keyboard.press("Control+Enter");
    await expect(dialog).toHaveCount(0);
    const toast = page.getByRole("dialog").filter({ hasText: en("bookmarks.modal.saved.created") });
    await expect(toast).toBeVisible();
    const trigger = page.getByRole("button", { name: en("palette.trigger"), exact: true });

    await test.step("Esc closes the palette and the focus is on the trigger", async () => {
      await openPaletteWithShortcut(page);
      await page.keyboard.press("Escape");
      await expect(paletteDialog(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(toast).toBeVisible();
      await page.keyboard.press("?");
      await expect(sheet).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await app.scan();
    });

    await test.step("a command that navigates leaves the focus on the trigger of the page it went to", async () => {
      await openPaletteWithShortcut(page);
      await page.keyboard.type("Tags");
      await expectHighlighted(page, paletteDialog(page).getByRole("option").filter({ hasText: /^Tags/ }).first());
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/tags(\?|$)/);
      await expect(paletteDialog(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(toast).toBeVisible();
      await page.keyboard.press("?");
      await expect(sheet).toBeVisible();
      await page.keyboard.press("Escape");
      await app.scan();
    });
  });

  test("moves the focus on when a chip is taken from the keyboard: to the field it filled, or the next chip", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    const slug = `typed-${token}`;
    await page.route(SUGGESTIONS, (route) =>
      route.fulfill({ json: { title: `Suggested ${token}`, slug: `suggested-${token}`, tags: [`one-${token}`, `two-${token}`], confidence: 0.9 } }),
    );
    const { dialog, suggest, sheet, field, group } = await open(page, app);
    const tags = dialog.getByRole("combobox", { name: en("bookmarks.modal.tags.label"), exact: true });
    await tags.fill(`own-${token}`);
    await page.getByRole("option", { name: en("bookmarks.modal.tags.create", { name: `own-${token}` }), exact: true }).click();
    await dialog.getByRole("heading", { name: en("bookmarks.modal.create.title"), exact: true }).click();
    await field("bookmarks.modal.url.label").fill(address);
    await field("bookmarks.modal.title.label").fill(`Typed ${token}`);
    await field("bookmarks.modal.slug.label").fill(slug);

    await suggest.focus();
    await page.keyboard.press("Enter");
    await expect(group("bookmarks.modal.suggest.chips.title")).toBeVisible();

    const titleChip = group("bookmarks.modal.suggest.chips.title").getByRole("button");
    await titleChip.focus();
    await page.keyboard.press("Enter");
    await expect(field("bookmarks.modal.title.label")).toHaveValue(`Suggested ${token}`);
    await expect(field("bookmarks.modal.title.label")).toBeFocused();

    const slugChip = group("bookmarks.modal.suggest.chips.slug").getByRole("button");
    await slugChip.focus();
    await page.keyboard.press("Space");
    await expect(field("bookmarks.modal.slug.label")).toHaveValue(`suggested-${token}`);
    await expect(field("bookmarks.modal.slug.label")).toBeFocused();

    const tagChips = group("bookmarks.modal.suggest.chips.tags").getByRole("button");
    await expect(tagChips).toHaveText([`one-${token}`, `two-${token}`]);
    await tagChips.first().focus();
    await page.keyboard.press("Enter");
    await expect(tagChips).toHaveText([`two-${token}`]);
    await expect(tagChips.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(group("bookmarks.modal.suggest.chips.tags")).toHaveCount(0);
    await expect(tags).toBeFocused();

    expect(await focusInside(dialog), "the focus is inside the dialog").toBe(true);
    await app.scan();
    // A key does nothing while the modal is open, with the focus on the page behind it too.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    expect(await focusInside(dialog), "the focus has left the dialog").toBe(false);
    await page.keyboard.press("?");
    await afterRender(page);
    await expect(sheet).toHaveCount(0);
  });

  test("does not open the shortcut list behind the modal while a save started from a field is under way or has been refused", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    let sent = 0;
    await page.route(BOOKMARKS, async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      sent += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refuse(route, 500, "internal_error");
    });
    const { dialog, sheet, field } = await open(page, app);
    await field("bookmarks.modal.url.label").fill(address);
    await field("bookmarks.modal.title.label").fill(`Typed ${token}`);

    for (const [index, save] of ["Enter", "Control+Enter"].entries()) {
      await field("bookmarks.modal.title.label").focus();
      await page.keyboard.press(save);
      await expect.poll(() => sent, { message: `the ${save} save was sent` }).toBe(index + 1);
      // While the request is under way the fields are disabled.
      await expect(field("bookmarks.modal.title.label")).toBeDisabled();
      await page.keyboard.press("?");
      await afterRender(page);
      await expect(sheet).toHaveCount(0);
      // The save is refused, the fields are back, and the focus may be anywhere: behind the modal it must not act.
      await expect(field("bookmarks.modal.title.label")).toBeEnabled();
      await page.keyboard.press("?");
      await afterRender(page);
      await expect(sheet).toHaveCount(0);
      await expect(dialog).toBeVisible();
    }
  });

  test("holds the room of the action while the reads that decide it are on their way, so the fields do not move when it shows", async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    for (const read of ["**/entitlements*", WORKSPACE]) {
      await page.route(read, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await route.fallback();
      });
    }
    const { dialog, suggest } = modal(page);
    await page.goto("/bookmarks?new=1");
    await expect(dialog).toBeVisible();

    // How far the URL field stands below the top of the dialog, from layout and not from where an animation has the dialog: seen on every frame
    // from the dialog showing until the action has shown.
    const tops = await page.evaluate(
      ({ label, suggestLabel }) =>
        new Promise<number[]>((resolve) => {
          const seen = new Set<number>();
          const started = performance.now();
          let shownAt: number | undefined;
          const offsetWithin = (element: HTMLElement, root: HTMLElement): number => {
            let top = 0;
            for (let current: HTMLElement | null = element; current !== null && current !== root; current = current.offsetParent as HTMLElement | null) {
              top += current.offsetTop;
            }
            return top;
          };
          const tick = (): void => {
            const root = document.querySelector<HTMLElement>("[role='dialog']");
            const input = Array.from(root?.querySelectorAll("label") ?? []).find((candidate) => candidate.textContent === label)?.control;
            if (root !== null && input instanceof HTMLElement) {
              seen.add(offsetWithin(input, root));
            }
            const shown = Array.from(root?.querySelectorAll("button") ?? []).some((button) => button.textContent === suggestLabel);
            if (shown && shownAt === undefined) {
              shownAt = performance.now();
            }
            if ((shownAt !== undefined && performance.now() - shownAt > 300) || performance.now() - started > 8000) {
              resolve([...seen]);
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        }),
      { label: en("bookmarks.modal.url.label"), suggestLabel: en("bookmarks.modal.suggest.label") },
    );

    await expect(suggest).toBeVisible();
    expect(tops, "the distances of the URL field from the top of the dialog").toHaveLength(1);
    await app.scan();
  });
});

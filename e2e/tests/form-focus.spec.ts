import { randomBytes } from "node:crypto";
import type { Locator, Page, Route } from "@playwright/test";
import { message } from "../support/catalog.ts";
import { appOrigin } from "../support/environment.ts";
import { expect, test, type App } from "../support/test.ts";

// Where the focus is while a form over the page saves and after the save is refused (doc 03 section 15, doc 08 section 5.2). A form
// disables its fields while it saves, and a browser takes the focus from a field that is disabled under it: Chromium and Firefox put
// it on the page body, where a Tab reaches the page behind the overlay. Every form built on the shared overlay keeps the focus inside
// it for as long as the save lasts, says it is busy, sends nothing for a second Enter, and gives the focus back to the field that had it
// when the save is refused. The save is held by the page's own route handler and then refused, so nothing is made on the server.

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

const MUTATION = { origin: appOrigin(), "content-type": "application/json" };

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

interface Held {
  /** Resolves with the first request of the save that reached the page's handler. */
  readonly arrived: Promise<void>;
  /** How many saves reached the handler. */
  readonly count: () => number;
  /** Refuses the held saves. */
  readonly release: () => void;
}

/** Holds the writes of one method to a path until `release`, then answers them with 503. */
async function holdSave(page: Page, glob: string, method: string): Promise<Held> {
  let arrive: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  await page.route(glob, async (route: Route) => {
    if (route.request().method() !== method) {
      await route.fallback();
      return;
    }
    count += 1;
    arrive();
    await gate;
    await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({ type: "https://slugbase.app/problems/service_unavailable", title: "service_unavailable", status: 503, code: "service_unavailable", detail: "refused on purpose", requestId: "e2e-form-focus" }),
    });
  });
  return { arrived, count: () => count, release };
}

interface Opened {
  readonly dialog: Locator;
  /** The field the member types in and presses the key from. */
  readonly field: Locator;
}

interface FormCase {
  readonly name: string;
  readonly method: "POST" | "PATCH";
  readonly glob: string;
  readonly key: "Enter" | "Control+Enter";
  readonly open: (page: Page, app: App, token: string) => Promise<Opened>;
  /** What the form needs in its field before it sends anything. */
  readonly value: (token: string) => string;
  readonly prepare?: (page: Page, token: string) => Promise<() => Promise<void>>;
}

async function inside(dialog: Locator): Promise<boolean> {
  return dialog.evaluate((root) => root.contains(document.activeElement) && document.activeElement !== document.body);
}

const CASES: readonly FormCase[] = [
  {
    name: "the bookmark form",
    method: "POST",
    glob: "**/api/v1/bookmarks",
    key: "Control+Enter",
    value: (token) => `Saved ${token}`,
    open: async (page, app, token) => {
      const dialog = page.getByRole("dialog", { name: en("bookmarks.modal.create.title"), exact: true });
      await app.visit("/bookmarks?new=1", dialog);
      await dialog.getByLabel(en("bookmarks.modal.url.label"), { exact: true }).fill(`https://focus-${token}.invalid/page`);
      return { dialog, field: dialog.getByLabel(en("bookmarks.modal.title.label"), { exact: true }) };
    },
  },
  {
    name: "the folder form",
    method: "POST",
    glob: "**/api/v1/folders",
    key: "Enter",
    value: (token) => `Folder ${token}`,
    open: async (page, app) => {
      const dialog = page.getByRole("dialog", { name: en("folders.form.title.create"), exact: true });
      await app.visit("/folders?create=1", dialog);
      return { dialog, field: dialog.getByRole("textbox", { name: en("folders.form.name.label"), exact: true }) };
    },
  },
  {
    name: "the team form",
    method: "POST",
    glob: "**/api/v1/teams",
    key: "Enter",
    value: (token) => `Team ${token}`,
    open: async (page, app) => {
      await app.visit("/settings/workspace/teams", page.getByRole("heading", { level: 1, name: en("teams.title"), exact: true }));
      await page.getByRole("button", { name: en("teams.create"), exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: en("teams.form.title.create"), exact: true });
      await expect(dialog).toBeVisible();
      return { dialog, field: dialog.getByRole("textbox", { name: en("teams.form.name.label"), exact: true }) };
    },
  },
  {
    name: "the tag rename form",
    method: "PATCH",
    glob: "**/api/v1/tags/*",
    key: "Enter",
    value: (token) => `renamed-${token}`,
    prepare: async (page, token) => {
      const made = await page.request.post("/api/v1/tags", { headers: MUTATION, data: { name: `tag-${token}` } });
      expect(made.status(), "POST /api/v1/tags").toBe(201);
      const { id } = (await made.json()) as { id: string };
      return async () => {
        await page.request.delete(`/api/v1/tags/${id}`, { headers: MUTATION });
      };
    },
    open: async (page, app, token) => {
      await app.visit("/tags", page.getByRole("heading", { level: 1, name: en("tags.page.title"), exact: true }));
      await page.getByRole("button", { name: en("tags.list.actionsFor", { name: `tag-${token}` }), exact: true }).click();
      await page.getByRole("menuitem", { name: en("tags.actions.rename"), exact: true }).click();
      const dialog = page.getByRole("dialog", { name: en("tags.form.title"), exact: true });
      await expect(dialog).toBeVisible();
      return { dialog, field: dialog.getByRole("textbox", { name: en("tags.form.name.label"), exact: true }) };
    },
  },
  {
    name: "the API token form",
    method: "POST",
    glob: "**/api/v1/me/api-tokens",
    key: "Enter",
    value: (token) => `Token ${token}`,
    open: async (page, app) => {
      await app.visit("/settings/account/tokens", page.getByRole("heading", { level: 1, name: en("settings.tokens.title"), exact: true }));
      await page.getByRole("button", { name: en("settings.tokens.new"), exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: en("settings.tokens.create.title"), exact: true });
      await expect(dialog).toBeVisible();
      return { dialog, field: dialog.getByRole("textbox", { name: en("settings.tokens.name.label"), exact: true }) };
    },
  },
  {
    name: "the new workspace form",
    method: "POST",
    glob: "**/api/v1/workspaces",
    key: "Enter",
    value: (token) => `Workspace ${token}`,
    open: async (page, app) => {
      // The stack's account may not create a workspace of its own; the switcher offers the action when the list says it can.
      await page.route("**/api/v1/workspaces", async (route) => {
        if (route.request().method() !== "GET") {
          await route.fallback();
          return;
        }
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, canCreate: true } });
      });
      await app.visit("/", page.getByRole("button", { name: new RegExp(`^${en("workspaces.switcher.label")}:`) }));
      await page.getByRole("button", { name: new RegExp(`^${en("workspaces.switcher.label")}:`) }).click();
      await page.getByRole("menuitem", { name: en("workspaces.switcher.new"), exact: true }).click();
      const dialog = page.getByRole("dialog", { name: en("workspaces.create.title"), exact: true });
      await expect(dialog).toBeVisible();
      return { dialog, field: dialog.getByRole("textbox", { name: en("workspaces.create.name.label"), exact: true }) };
    },
  },
];

for (const form of CASES) {
  test(`${form.name} keeps the focus inside the overlay while it saves and gives it back to the field when the save is refused`, async ({ page, app, account }) => {
    await account.set({ locale: "en" });
    const token = randomBytes(4).toString("hex");
    const cleanup = form.prepare === undefined ? undefined : await form.prepare(page, token);
    try {
      const { dialog, field } = await form.open(page, app, token);
      await field.fill(form.value(token));
      await field.focus();
      const held = await holdSave(page, form.glob, form.method);
      const body = dialog.locator("form");

      await page.keyboard.press(form.key);
      await held.arrived;
      await afterRender(page);

      expect(await inside(dialog), "the focus is inside the overlay while the save is held").toBe(true);
      await expect(body).toHaveAttribute("aria-busy", "true");

      await page.keyboard.press(form.key);
      await afterRender(page);
      expect(held.count(), "saves sent after a second press of the key").toBe(1);
      expect(await inside(dialog), "the focus is inside the overlay after the second press").toBe(true);

      held.release();

      await expect(field).toBeFocused();
      await expect(body).not.toHaveAttribute("aria-busy", "true");
      await expect(dialog).toBeVisible();
      await app.scan();
    } finally {
      await cleanup?.();
    }
  });
}

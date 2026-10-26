import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { message } from "../support/catalog.ts";
import { expectNoCspViolations, watchCsp } from "../support/csp.ts";
import { STORAGE_STATE } from "../support/environment.ts";
import { OWNER_EMAIL, OWNER_NAME, SECOND_OWNER_EMAIL, SECOND_WORKSPACE_NAME, WORKSPACE_NAME } from "../support/instance.ts";
import { createWorkspace, enrolSecondFactor } from "../support/instance-admin.ts";
import { productName } from "../support/product.ts";
import { expect, test } from "../support/test.ts";

// The first step of the accounts journey (doc 12 Phase 2 definition of done, doc 02 section 2.2): an
// operator claims a fresh instance through the first-run wizard, with the one-time setup token that the
// server printed to its log (E2E_SETUP_TOKEN, read by e2e/with-stack.sh), and lands signed in on an empty
// home page. The session is kept as the state every other journey starts from (playwright.config.ts).
// The title starts with the journey's name, so that `--grep "accounts journey"` runs this step first.
//
// The account is made up for this run and its password is random; neither the password nor the token is
// printed, and a message that fails here names the step, never a value.
//
// The owner is the instance admin, and CE lets only an instance admin with a second factor create a workspace
// (ALLOW_WORKSPACE_CREATION is false; doc 04 section 10.10). The setup therefore turns on an authenticator app for
// the owner through the API of the security page, with the password it holds only in memory, and creates one
// workspace through the instance-admin API to show the run can: a journey that needs a second workspace calls
// `createWorkspace` of support/instance-admin.ts on the owner's session. The setup key is not kept, because the
// policy asks for an enrolled second factor and not for a code.

test("accounts journey: the first-run setup claims the instance and signs the owner in", async ({ page, app }) => {
  const token = process.env.E2E_SETUP_TOKEN ?? "";
  const csp = await watchCsp(page);
  const name = await productName(page);
  const password = randomBytes(24).toString("base64url");
  const setupStatus = await page.request.get("/api/v1/setup/status");
  expect(setupStatus.ok(), "GET /api/v1/setup/status").toBe(true);
  expect(((await setupStatus.json()) as { setupRequired?: unknown }).setupRequired, "first-run setup is pending on a fresh stack").toBe(true);

  const wizard = page.getByRole("heading", { level: 1, name: message("en", "setup.title", { name }) });
  const next = page.getByRole("button", { name: message("en", "setup.next"), exact: true });
  // A server that requires no setup token starts the wizard at the account.
  const stepOf = (step: number, count: number) => page.getByText(message("en", "setup.step", { step: String(step), count: String(count) }));
  const count = token === "" ? 2 : 3;
  let step = 1;

  // The home page sends a visitor of an unclaimed instance to the wizard.
  await app.visit("/", wizard);
  await expect(page).toHaveURL(/\/setup$/);

  if (token !== "") {
    await expect(stepOf(step, count)).toBeVisible();
    await expect(page.getByRole("heading", { name: message("en", "setup.token.title") })).toBeVisible();
    await page.getByLabel(message("en", "setup.token.label"), { exact: true }).fill(token);
    await app.scan();
    await next.click();
    step += 1;
  }

  await expect(stepOf(step, count)).toBeVisible();
  await expect(page.getByRole("heading", { name: message("en", "setup.account.title") })).toBeVisible();
  await page.getByLabel(message("en", "setup.account.name.label"), { exact: true }).fill(OWNER_NAME);
  await page.getByLabel(message("en", "setup.account.email.label"), { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel(message("en", "setup.account.password.label"), { exact: true }).fill(password);
  await app.scan();
  await next.click();
  step += 1;

  await expect(stepOf(step, count)).toBeVisible();
  await expect(page.getByRole("heading", { name: message("en", "setup.workspace.title") })).toBeVisible();
  await page.getByLabel(message("en", "setup.workspace.name.label"), { exact: true }).fill(WORKSPACE_NAME);
  await app.scan();
  await page.getByRole("button", { name: message("en", "setup.finish"), exact: true }).click();

  await expect(page.getByRole("heading", { name: message("en", "setup.done.title") })).toBeVisible();
  await app.scan();
  await page.getByRole("button", { name: message("en", "setup.done.home"), exact: true }).click();

  await expect(page.getByRole("heading", { level: 1, name: message("en", "home.empty.title", { name }) })).toBeVisible();
  await app.scan();
  await expect(page.getByRole("button", { name: message("en", "shell.account"), exact: true })).toBeVisible();
  // The wizard and the page it ends on load without a violation of the page's policy (doc 01 section 4 step 2).
  expectNoCspViolations(csp, "the first-run wizard");

  // The wizard is gone for good once an account exists.
  const again = await page.request.get("/api/v1/setup/status");
  expect(((await again.json()) as { setupRequired?: unknown }).setupRequired, "first-run setup is done").toBe(false);

  // The confirmation of the enrolment replaces the session cookie, which the context shares with `page.request`,
  // so the state saved below holds the new session.
  await enrolSecondFactor(page.request, password);
  // The workspace waits for an owner who never accepts, so the owner stays a member of the one workspace the other journeys use.
  await createWorkspace(page.request, SECOND_WORKSPACE_NAME, { ownerEmail: SECOND_OWNER_EMAIL });

  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE });
});

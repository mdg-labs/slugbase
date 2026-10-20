import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import type { WebExtension } from "../src/extensions/index.ts";
import { json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import {
  GRACE,
  INVITATIONS_PATH,
  INVITE_LINK_ORIGIN,
  SELF,
  stubWorkspaceSettingsServer,
  type Role,
  type TestInvitation,
  type WorkspaceSettingsServerOptions,
} from "./workspace-settings-server.ts";

// The invitations of /settings/workspace/members (doc 03 section 11.7, doc 02 section 3.4). The failure scenarios are an
// invitation sent as one request for all addresses or without its own idempotency key, a result that hides which address
// failed, a Resend offered where the server cannot send mail, an expired invitation that cannot be renewed, a list that
// failed to load shown as an empty one, and a seat slot that leaves a trace when nothing fills it.

const SLOW_TEST_TIMEOUT_MS = 30_000;

const PENDING: TestInvitation = {
  id: "0192f3a0-dddd-7000-8000-000000000001",
  email: "linus@example.org",
  role: "member",
  invitedBy: SELF.accountId,
  expiresAt: "2026-10-25T10:00:00.000Z",
};

const EXPIRED: TestInvitation = {
  id: "0192f3a0-dddd-7000-8000-000000000002",
  email: "barbara@example.org",
  role: "admin",
  invitedBy: null,
  expiresAt: "2026-10-01T10:00:00.000Z",
  expired: true,
};

const ORPHAN: TestInvitation = {
  id: "0192f3a0-dddd-7000-8000-000000000003",
  email: "tim@example.org",
  role: "member",
  invitedBy: "0192f3a0-bbbb-7000-8000-0000000000ff",
  expiresAt: "2026-10-25T10:00:00.000Z",
};

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function openMembers(extensions: readonly WebExtension[] = []): Promise<void> {
  window.history.replaceState(null, "", "/settings/workspace/members");
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function openInvitations(extensions: readonly WebExtension[] = []): Promise<HTMLElement> {
  await openMembers(extensions);
  return screen.findByRole("table", { name: "Invitations" });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

function rowOf(email: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: "Invitations" }))
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(email) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${email}`);
  }
  return row;
}

async function openActions(email: string): Promise<string[]> {
  await press(within(rowOf(email)).getByRole("button", { name: `Actions for the invitation of ${email}` }));
  return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
}

async function openInvite(): Promise<HTMLElement> {
  await press(await screen.findByRole("button", { name: "Invite people" }));
  return screen.findByRole("dialog", { name: "Invite people" });
}

async function typeAddresses(dialog: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Email addresses" }), { target: { value: text } });
    await Promise.resolve();
  });
}

function server(options: WorkspaceSettingsServerOptions = {}) {
  return stubWorkspaceSettingsServer({ members: [SELF, GRACE], ...options });
}

describe("the pending invitations", () => {
  it("lists email, role, who invited, status and expiry, and marks an expired invitation", async () => {
    server({ invitations: [PENDING, EXPIRED, ORPHAN] });
    await openInvitations();

    const columns = within(screen.getByRole("table", { name: "Invitations" })).getAllByRole("columnheader").map((header) => header.textContent);
    expect(columns).toEqual(["Email", "Role", "Invited by", "Status", "Expires", "Actions"]);
    const cells = (email: string): string[] => within(rowOf(email)).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells("linus@example.org").slice(0, 4)).toEqual(["linus@example.org", "Member", "Ada Lovelace", "Pending"]);
    expect(cells("linus@example.org")[4]).toContain("2026");
    expect(cells("barbara@example.org").slice(0, 4)).toEqual(["barbara@example.org", "Admin", "Deleted account", "Expired"]);
    expect(cells("tim@example.org")[2]).toBe("Former member");
  }, SLOW_TEST_TIMEOUT_MS);

  it("says there are none instead of showing an empty table", async () => {
    server();
    await openMembers();

    expect(await screen.findByText("No pending invitations")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Invitations" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a wait until the list arrives", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server({
      invitations: [PENDING],
      invitationsGet: async () => {
        await gate;
        return json({ items: [{ ...PENDING, teamIds: [], status: "pending", createdAt: "2026-10-10T08:00:00.000Z", expired: false }], nextCursor: null });
      },
    });
    await openMembers();

    expect(await screen.findByRole("status", { name: "Loading invitations" })).toBeTruthy();
    expect(screen.queryByText("No pending invitations")).toBeNull();
    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByRole("table", { name: "Invitations" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading invitations" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says the list could not be loaded instead of showing it as empty, and loads it again on retry", async () => {
    server({
      invitations: [PENDING],
      invitationsGet: (call) =>
        call <= 3
          ? problem(503, "unavailable", "req-503")
          : json({ items: [{ ...PENDING, teamIds: [], status: "pending", createdAt: "2026-10-10T08:00:00.000Z", expired: false }], nextCursor: null }),
    });
    await openMembers();

    expect(await screen.findByText("The invitations could not be loaded", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("No pending invitations")).toBeNull();
    await press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("table", { name: "Invitations" })).toBeTruthy();
    expect(screen.queryByText("The invitations could not be loaded")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a plain member the 403 page and asks for no invitations", async () => {
    const stub = server({ role: "member", invitations: [PENDING] });
    await openMembers();

    expect(await screen.findByRole("heading", { name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Invitations" })).toBeNull();
    expect(stub.received("GET", INVITATIONS_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("has no axe violations", async () => {
    server({ invitations: [PENDING, EXPIRED] });
    await openInvitations();

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the seats slot", () => {
  const seats: WebExtension = { id: "seats", slots: { "settings.workspace.members.seats": () => <p>4 of 5 seats used</p> } };

  it("renders the filling component above the table", async () => {
    server({ invitations: [PENDING] });
    const table = await openInvitations([seats]);

    const note = screen.getByText("4 of 5 seats used");
    expect(note.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("leaves nothing behind without an extension", async () => {
    server({ invitations: [PENDING] });
    await openInvitations();

    const section = screen.getByRole("region", { name: "Invitations" });
    expect(Array.from(section.children, (child) => child.tagName)).toEqual(["DIV", "DIV"]);
    expect(screen.queryByText("4 of 5 seats used")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the row actions", () => {
  it("offers no Resend where the server cannot send mail, and gives an expired invitation a link instead", async () => {
    server({ invitations: [EXPIRED] });
    await openInvitations();

    expect(await openActions("barbara@example.org")).toEqual(["Copy invitation link", "Revoke"]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("offers Resend, the link and Revoke where the server can send mail", async () => {
    server({ mail: true, invitations: [EXPIRED] });
    await openInvitations();

    expect(await openActions("barbara@example.org")).toEqual(["Resend", "Copy invitation link", "Revoke"]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("resends an expired invitation and shows it as renewed", async () => {
    const stub = server({ mail: true, invitations: [EXPIRED] });
    await openInvitations();
    await openActions("barbara@example.org");

    await press(screen.getByRole("menuitem", { name: "Resend" }));

    expect(await screen.findByText("The invitation for barbara@example.org was sent again")).toBeTruthy();
    await waitFor(() => {
      expect(within(rowOf("barbara@example.org")).getByText("Pending")).toBeTruthy();
    });
    expect(stub.received("POST", `${INVITATIONS_PATH}/${EXPIRED.id}/resend`)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("tells the member a server that cannot send mail refused the resend", async () => {
    server({ mail: true, invitations: [PENDING], invitationResend: () => problem(503, "mail_unavailable", "req-503") });
    await openInvitations();
    await openActions("linus@example.org");

    await press(screen.getByRole("menuitem", { name: "Resend" }));

    expect((await screen.findAllByText("This server cannot send email. Copy the invitation link instead.")).length).toBeGreaterThan(0);
    expect(screen.queryByText("The invitation for linus@example.org was sent again")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("reports a resend that failed in an error toast", async () => {
    server({ mail: true, invitations: [PENDING], invitationResend: () => problem(500, "internal_error", "req-500") });
    await openInvitations();
    await openActions("linus@example.org");

    await press(screen.getByRole("menuitem", { name: "Resend" }));

    expect((await screen.findAllByText("req-500", { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText("The invitation for linus@example.org was sent again")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says an invitation that is no longer pending is gone and loads the list again", async () => {
    const stub = server({ mail: true, invitations: [PENDING], invitationResend: () => problem(404, "not_found", "req-404") });
    await openInvitations();
    const before = stub.received("GET", INVITATIONS_PATH).length;
    await openActions("linus@example.org");

    await press(screen.getByRole("menuitem", { name: "Resend" }));

    expect((await screen.findAllByText("This invitation is no longer pending. The list has been reloaded.")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(stub.received("GET", INVITATIONS_PATH).length).toBeGreaterThan(before);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("makes a link, shows it once and renews the invitation", async () => {
    const stub = server({ invitations: [EXPIRED] });
    await openInvitations();
    await openActions("barbara@example.org");

    await press(screen.getByRole("menuitem", { name: "Copy invitation link" }));

    const dialog = await screen.findByRole("dialog", { name: "Invitation link" });
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Invitation link" }).value).toBe(`${INVITE_LINK_ORIGIN}token-1`);
    expect(within(dialog).getByText(/shown only once/)).toBeTruthy();
    expect(stub.received("POST", `${INVITATIONS_PATH}/${EXPIRED.id}/link`)).toHaveLength(1);

    await press(within(dialog).getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Invitation link" })).toBeNull();
    });
    await waitFor(() => {
      expect(within(rowOf("barbara@example.org")).getByText("Pending")).toBeTruthy();
    });
    expect(screen.queryByDisplayValue(`${INVITE_LINK_ORIGIN}token-1`)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("offers the link where the server can send mail as well", async () => {
    server({ mail: true, invitations: [PENDING] });
    await openInvitations();
    await openActions("linus@example.org");

    await press(screen.getByRole("menuitem", { name: "Copy invitation link" }));

    expect(await screen.findByRole("dialog", { name: "Invitation link" })).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("asks before it revokes, sends nothing on Cancel and removes the invitation on confirmation", async () => {
    const stub = server({ invitations: [PENDING, EXPIRED] });
    await openInvitations();
    await openActions("linus@example.org");
    await press(screen.getByRole("menuitem", { name: "Revoke" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke the invitation for linus@example.org?" });

    await press(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(stub.received("DELETE", `${INVITATIONS_PATH}/${PENDING.id}`)).toHaveLength(0);

    await openActions("linus@example.org");
    await press(screen.getByRole("menuitem", { name: "Revoke" }));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke invitation" }));

    expect(await screen.findByText("The invitation for linus@example.org was revoked")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("linus@example.org", { selector: "td span" })).toBeNull();
    });
    expect(stub.received("DELETE", `${INVITATIONS_PATH}/${PENDING.id}`)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("reports a revocation that failed, keeps the confirmation and the invitation, and lets the member try again", async () => {
    const stub = server({
      invitations: [PENDING],
      invitationDelete: (call) => (call === 1 ? problem(503, "unavailable", "req-503") : new Response(null, { status: 204 })),
    });
    await openInvitations();
    await openActions("linus@example.org");
    await press(screen.getByRole("menuitem", { name: "Revoke" }));
    const confirm = await screen.findByRole("alertdialog");

    await press(within(confirm).getByRole("button", { name: "Revoke invitation" }));

    expect((await screen.findAllByText("req-503", { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText("The invitation for linus@example.org was revoked")).toBeNull();
    await waitFor(() => {
      expect(within(confirm).getByRole("button", { name: "Revoke invitation" }).hasAttribute("disabled")).toBe(false);
    });
    await press(within(confirm).getByRole("button", { name: "Revoke invitation" }));
    expect(await screen.findByText("The invitation for linus@example.org was revoked")).toBeTruthy();
    expect(stub.received("DELETE", `${INVITATIONS_PATH}/${PENDING.id}`)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the invite dialog", () => {
  it("sends one request per address, each with its own idempotency key and the chosen role", async () => {
    const stub = server();
    await openMembers();
    const dialog = await openInvite();

    await typeAddresses(dialog, "new@example.org, other@example.org,");
    const input = within(dialog).getByRole("textbox", { name: "Email addresses" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "third@example.org" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(within(within(dialog).getByRole("list", { name: "Addresses to invite" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "new@example.orgRemove",
      "other@example.orgRemove",
      "third@example.orgRemove",
    ]);
    await press(within(dialog).getByRole("radio", { name: "Admin" }));
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));

    const results = await screen.findByRole("list", { name: "Result for each address" });
    expect(within(results).getAllByRole("listitem")).toHaveLength(3);
    const sent = stub.received("POST", INVITATIONS_PATH);
    expect(sent.map(({ body }) => body)).toEqual([
      { email: "new@example.org", role: "admin" },
      { email: "other@example.org", role: "admin" },
      { email: "third@example.org", role: "admin" },
    ]);
    const keys = sent.map(({ idempotencyKey }) => idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(screen.getByText("3 of 3 invited.")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("describes both roles and starts at Member", async () => {
    server();
    await openMembers();
    const dialog = await openInvite();

    expect(within(dialog).getByText("Manages members, invitations and the settings of the workspace.")).toBeTruthy();
    expect(within(dialog).getByText("Uses the workspace's bookmarks and folders and cannot manage members or settings.")).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "Member" }).getAttribute("aria-checked")).toBe("true");
  }, SLOW_TEST_TIMEOUT_MS);

  it("lists the outcome of each address, including a current member, and shows the new invitation in the list", async () => {
    const stub = server();
    await openMembers();
    const dialog = await openInvite();
    await typeAddresses(dialog, "new@example.org, grace@example.org");
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));

    const results = await screen.findByRole("list", { name: "Result for each address" });
    const [created, member] = within(results).getAllByRole("listitem");
    expect(created?.textContent).toContain("new@example.org");
    expect(created?.textContent).toContain("Invited");
    expect(member?.textContent).toContain("grace@example.org");
    expect(member?.textContent).toContain("Skipped");
    expect(member?.textContent).toContain("Already a member of this workspace.");
    expect(screen.getByText("1 of 2 invited.")).toBeTruthy();
    expect(stub.received("POST", INVITATIONS_PATH)).toHaveLength(2);
    await press(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("table", { name: "Invitations" })).toBeTruthy();
    expect(within(rowOf("new@example.org")).getByText("Pending")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("lists the address that failed beside the ones that went through, and sends only it again, under its first key", async () => {
    const stub = server({
      invitationPost: (call) =>
        call === 2 ? problem(500, "internal_error", "req-500") : json({ id: `0192f3a0-dddd-7000-8000-00000000009${String(call)}`, email: "x@example.org", role: "member", teamIds: [], status: "pending", invitedBy: SELF.accountId, expiresAt: "2026-12-01T10:00:00.000Z", createdAt: "2026-10-10T08:00:00.000Z" }, { status: 201 }),
    });
    await openMembers();
    const dialog = await openInvite();
    await typeAddresses(dialog, "one@example.org, two@example.org, three@example.org");
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));

    const results = await screen.findByRole("list", { name: "Result for each address" });
    const items = within(results).getAllByRole("listitem");
    expect(items.map((item) => item.textContent.includes("Failed"))).toEqual([false, true, false]);
    expect(items[1]?.textContent).toContain("The invitation could not be created.");
    expect(items[1]?.textContent).toContain("Request ID: req-500");
    expect(screen.getByText("2 of 3 invited.")).toBeTruthy();

    await press(screen.getByRole("button", { name: "Try the failed ones again" }));
    const again = await screen.findByRole("dialog", { name: "Invite people" });
    expect(within(within(again).getByRole("list", { name: "Addresses to invite" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["two@example.orgRemove"]);
    await press(within(again).getByRole("button", { name: "Send invitations" }));

    await screen.findByRole("list", { name: "Result for each address" });
    const sent = stub.received("POST", INVITATIONS_PATH);
    expect(sent.map(({ body }) => (body as { email: string }).email)).toEqual(["one@example.org", "two@example.org", "three@example.org", "two@example.org"]);
    expect(sent[3]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
    expect(screen.getByText("1 of 1 invited.")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps an address that is not an address in the field with an explanation and sends nothing", async () => {
    const stub = server();
    await openMembers();
    const dialog = await openInvite();

    await typeAddresses(dialog, "good@example.org, not-an-address");
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));

    expect(await within(dialog).findByText("not-an-address is not a valid email address.")).toBeTruthy();
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Email addresses" }).value).toBe("not-an-address");
    expect(stub.received("POST", INVITATIONS_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("asks for an address when there is none", async () => {
    const stub = server();
    await openMembers();
    const dialog = await openInvite();

    await press(within(dialog).getByRole("button", { name: "Send invitations" }));

    expect(await within(dialog).findByText("Enter at least one email address.")).toBeTruthy();
    expect(stub.received("POST", INVITATIONS_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("takes an address once however it is spelled, and lets one be removed", async () => {
    const stub = server();
    await openMembers();
    const dialog = await openInvite();

    await typeAddresses(dialog, "Dup@example.org, dup@example.org, keep@example.org");
    await press(within(dialog).getByRole("button", { name: "Remove Dup@example.org" }));
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));

    await screen.findByRole("list", { name: "Result for each address" });
    expect(stub.received("POST", INVITATIONS_PATH).map(({ body }) => body)).toEqual([{ email: "keep@example.org", role: "member" }]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains where the server cannot send mail that the link is copied from the list", async () => {
    server();
    await openMembers();
    const dialog = await openInvite();

    expect(within(dialog).getByText(/cannot send email/)).toBeTruthy();
    await typeAddresses(dialog, "new@example.org");
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));
    expect(await screen.findByText("The invitation was created. Copy its link from the pending invitations.")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says nothing of missing mail where the server sends it", async () => {
    server({ mail: true });
    await openMembers();
    const dialog = await openInvite();

    expect(within(dialog).queryByText(/cannot send email/)).toBeNull();
    await typeAddresses(dialog, "new@example.org");
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));
    expect(await screen.findByText("The invitation was sent by email.")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it.each<[Role]>([["owner"], ["admin"]])("is offered to an %s", async (role) => {
    server({ role });
    await openMembers();

    expect(await screen.findByRole("button", { name: "Invite people" })).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RegisterRequestSchema } from "../src/operations/auth.ts";
import { CreateBookmarkRequestSchema, UpdateBookmarkRequestSchema } from "../src/operations/bookmarks.ts";
import { CreateFolderRequestSchema, ListFoldersQuerySchema, UpdateFolderRequestSchema } from "../src/operations/folders.ts";
import { AcceptInvitationRequestSchema } from "../src/operations/invitations.ts";
import { CreateInstanceWorkspaceRequestSchema, UpdateInstanceSettingsRequestSchema } from "../src/operations/instance.ts";
import { CreateApiTokenRequestSchema, UpdateAccountRequestSchema } from "../src/operations/me.ts";
import { SetupRequestSchema } from "../src/operations/setup.ts";
import { CreateTagRequestSchema, RenameTagRequestSchema } from "../src/operations/tags.ts";
import { CreateTeamRequestSchema, UpdateTeamRequestSchema } from "../src/operations/teams.ts";
import { NUL_MESSAGE, withoutNul } from "../src/operations/text.ts";
import { CreateWorkspaceRequestSchema, RenameWorkspaceRequestSchema } from "../src/operations/workspaces.ts";

const NUL = "\u0000";

function issuePaths(schema: z.ZodType, input: unknown): readonly string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("withoutNul", () => {
  const schema = withoutNul(z.string().trim().min(1).max(10));

  it("refuses a value with a NUL anywhere in it, with one message", () => {
    for (const value of [`${NUL}a`, `a${NUL}`, `a${NUL}b`, NUL]) {
      const result = schema.safeParse(value);
      expect(result.success, JSON.stringify(value)).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toContain(NUL_MESSAGE);
    }
  });

  it("keeps the rules of the schema it wraps and passes other control characters", () => {
    expect(schema.parse("  a\tb  ")).toBe("a\tb");
    expect(schema.safeParse("   ").success).toBe(false);
    expect(schema.safeParse("x".repeat(11)).success).toBe(false);
  });
});

describe("a NUL character in a text field a request stores", () => {
  const bookmark = { url: "https://example.com/", title: "Title" };
  const cases: readonly (readonly [string, z.ZodType, unknown, string])[] = [
    ["bookmark title (create)", CreateBookmarkRequestSchema, { ...bookmark, title: `a${NUL}b` }, "title"],
    ["bookmark description (create)", CreateBookmarkRequestSchema, { ...bookmark, description: `a${NUL}b` }, "description"],
    ["bookmark tag name (create)", CreateBookmarkRequestSchema, { ...bookmark, tagNames: [`a${NUL}b`] }, "tagNames.0"],
    ["bookmark title (update)", UpdateBookmarkRequestSchema, { title: `a${NUL}b` }, "title"],
    ["bookmark description (update)", UpdateBookmarkRequestSchema, { description: `a${NUL}b` }, "description"],
    ["bookmark tag name (update)", UpdateBookmarkRequestSchema, { tagNames: [`a${NUL}b`] }, "tagNames.0"],
    ["folder name (create)", CreateFolderRequestSchema, { name: `a${NUL}b` }, "name"],
    ["folder name (update)", UpdateFolderRequestSchema, { name: `a${NUL}b` }, "name"],
    ["folder search text", ListFoldersQuerySchema, { q: `a${NUL}b` }, "q"],
    ["tag name (create)", CreateTagRequestSchema, { name: `a${NUL}b` }, "name"],
    ["tag name (rename)", RenameTagRequestSchema, { name: `a${NUL}b` }, "name"],
    ["workspace name (create)", CreateWorkspaceRequestSchema, { name: `a${NUL}b` }, "name"],
    ["workspace name (rename)", RenameWorkspaceRequestSchema, { name: `a${NUL}b` }, "name"],
    ["workspace name (instance admin)", CreateInstanceWorkspaceRequestSchema, { name: `a${NUL}b`, ownerEmail: "owner@example.test" }, "name"],
    ["display name (account update)", UpdateAccountRequestSchema, { displayName: `a${NUL}b` }, "displayName"],
    ["display name (registration)", RegisterRequestSchema, { displayName: `a${NUL}b`, email: "a@example.test", password: "a long enough password" }, "displayName"],
    ["display name (invitation acceptance)", AcceptInvitationRequestSchema, { token: "t", displayName: `a${NUL}b`, password: "a long enough password" }, "displayName"],
    ["display name (setup)", SetupRequestSchema, { displayName: `a${NUL}b`, email: "a@example.test", password: "a long enough password", workspaceName: "Home" }, "displayName"],
    ["workspace name (setup)", SetupRequestSchema, { displayName: "Admin", email: "a@example.test", password: "a long enough password", workspaceName: `a${NUL}b` }, "workspaceName"],
    ["API token name", CreateApiTokenRequestSchema, { name: `a${NUL}b`, scope: "read" }, "name"],
    ["team name", CreateTeamRequestSchema, { name: `a${NUL}b` }, "name"],
    ["team description", UpdateTeamRequestSchema, { description: `a${NUL}b` }, "description"],
    ["instance display name", UpdateInstanceSettingsRequestSchema, { displayName: `a${NUL}b` }, "displayName"],
    ["instance sign-in notice", UpdateInstanceSettingsRequestSchema, { signInNotice: `a${NUL}b` }, "signInNotice"],
  ];

  it.each(cases)("is refused in the %s", (_name, schema, input, path) => {
    expect(issuePaths(schema, input)).toEqual([path]);
  });

  it("does not refuse the same requests without it", () => {
    expect(CreateBookmarkRequestSchema.safeParse({ ...bookmark, description: "d", tagNames: ["t"] }).success).toBe(true);
    expect(UpdateBookmarkRequestSchema.safeParse({ title: "t", description: null }).success).toBe(true);
    expect(CreateFolderRequestSchema.safeParse({ name: "n" }).success).toBe(true);
    expect(ListFoldersQuerySchema.safeParse({ q: "n" }).success).toBe(true);
    expect(CreateTagRequestSchema.safeParse({ name: "n" }).success).toBe(true);
    expect(CreateWorkspaceRequestSchema.safeParse({ name: "n" }).success).toBe(true);
    expect(CreateApiTokenRequestSchema.safeParse({ name: "n", scope: "read" }).success).toBe(true);
  });
});

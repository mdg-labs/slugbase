import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ForgotPasswordRequestSchema, LoginRequestSchema, RegisterRequestSchema, ResendVerifyEmailRequestSchema } from "../src/operations/auth.ts";
import { CreateBookmarkRequestSchema, UpdateBookmarkRequestSchema } from "../src/operations/bookmarks.ts";
import { CreateFolderRequestSchema, ListFoldersQuerySchema, UpdateFolderRequestSchema } from "../src/operations/folders.ts";
import { AcceptInvitationRequestSchema, CreateInvitationRequestSchema } from "../src/operations/invitations.ts";
import { CreateInstanceWorkspaceRequestSchema, UpdateInstanceSettingsRequestSchema } from "../src/operations/instance.ts";
import { CreateApiTokenRequestSchema, RequestEmailChangeRequestSchema, UpdateAccountRequestSchema } from "../src/operations/me.ts";
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

describe("a NUL character in the email of a request that looks an account up by it", () => {
  const cases: readonly (readonly [string, z.ZodType, unknown])[] = [
    ["sign-in", LoginRequestSchema, { email: `a${NUL}b@example.test`, password: "a password" }],
    ["sign-in, at the end", LoginRequestSchema, { email: `a@example.test${NUL}`, password: "a password" }],
    ["password reset", ForgotPasswordRequestSchema, { email: `a${NUL}b@example.test` }],
    ["verification resend", ResendVerifyEmailRequestSchema, { email: `a${NUL}b@example.test` }],
    ["registration", RegisterRequestSchema, { displayName: "Ada", email: `a${NUL}b@example.test`, password: "a long enough password" }],
    ["email change", RequestEmailChangeRequestSchema, { email: `a${NUL}b@example.test` }],
    ["invitation", CreateInvitationRequestSchema, { email: `a${NUL}b@example.test`, role: "member" }],
    ["setup", SetupRequestSchema, { displayName: "Admin", email: `a${NUL}b@example.test`, password: "a long enough password", workspaceName: "Home" }],
    ["instance workspace owner", CreateInstanceWorkspaceRequestSchema, { name: "Home", ownerEmail: `a${NUL}b@example.test` }],
  ];

  it.each(cases)("is refused in the %s with one field error on the email", (_name, schema, input) => {
    const paths = issuePaths(schema, input);
    expect(paths.length).toBe(1);
    expect(paths[0]).toMatch(/^(email|ownerEmail)$/);
  });

  it("does not refuse the same sign-in without it", () => {
    expect(LoginRequestSchema.safeParse({ email: "a@example.test", password: "a password" }).success).toBe(true);
  });
});

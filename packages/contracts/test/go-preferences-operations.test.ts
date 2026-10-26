import { describe, expect, it } from "vitest";
import {
  GoPreferenceListSchema,
  GoPreferenceParamsSchema,
  ListGoPreferencesQuerySchema,
  deleteGoPreference,
  listGoPreferences,
  operations,
} from "../src/index.ts";

// The remembered go choices of doc 04 section 10.3: the list takes the read scope of a token and the forgetting the write scope, both as a member in the active workspace.

const UUID = "0192f3a0-aaaa-7000-8000-00000000a0b1";
const ITEM = { slug: "mail", bookmarkId: UUID, title: "Mail", host: "mail.example.com", owner: null };

describe("the go preference operations", () => {
  it("are GET /api/v1/me/go-preferences (read) and DELETE /api/v1/me/go-preferences/{slug} (write), members' operations of the me tag", () => {
    expect(listGoPreferences).toMatchObject({ method: "get", path: "/api/v1/me/go-preferences", operationId: "listGoPreferences", tag: "me", auth: "member", rate: "read", scope: "read" });
    expect(deleteGoPreference).toMatchObject({ method: "delete", path: "/api/v1/me/go-preferences/{slug}", operationId: "deleteGoPreference", tag: "me", auth: "member", rate: "write", scope: "write" });
    expect(operations).toEqual(expect.arrayContaining([listGoPreferences, deleteGoPreference]));
  });

  it("declare the answers a client has to handle", () => {
    expect(Object.keys(listGoPreferences.responses).map(Number)).toEqual(expect.arrayContaining([200, 400, 401, 404, 422, 429, 503]));
    expect(Object.keys(deleteGoPreference.responses).map(Number)).toEqual(expect.arrayContaining([204, 400, 401, 403, 404, 422, 429, 503]));
  });
});

describe("the list", () => {
  it("is a page of choices with the cursor of the next, each naming a bookmark without its address", () => {
    expect(GoPreferenceListSchema.safeParse({ items: [ITEM], nextCursor: null }).success).toBe(true);
    expect(GoPreferenceListSchema.safeParse({ items: [{ ...ITEM, owner: { accountId: UUID, displayName: "Ann" } }], nextCursor: "abc" }).success).toBe(true);
    expect(GoPreferenceListSchema.safeParse({ items: [{ ...ITEM, url: "https://mail.example.com/" }], nextCursor: null }).success).toBe(false);
    expect(GoPreferenceListSchema.safeParse({ items: [ITEM] }).success).toBe(false);
  });

  it("takes a limit of 1 to 100, 50 when left out, and a cursor, and nothing else", () => {
    expect(ListGoPreferencesQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ListGoPreferencesQuerySchema.parse({ limit: "100", cursor: "abc" })).toEqual({ limit: 100, cursor: "abc" });
    expect(ListGoPreferencesQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(ListGoPreferencesQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(ListGoPreferencesQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(ListGoPreferencesQuerySchema.safeParse({ cursor: "a".repeat(513) }).success).toBe(false);
    expect(ListGoPreferencesQuerySchema.safeParse({ sort: "name" }).success).toBe(false);
  });
});

describe("the forgetting", () => {
  it("takes a slug of any text, which the server judges", () => {
    expect(GoPreferenceParamsSchema.safeParse({ slug: "mail" }).success).toBe(true);
    expect(GoPreferenceParamsSchema.safeParse({ slug: "Not a slug" }).success).toBe(true);
    expect(GoPreferenceParamsSchema.safeParse({}).success).toBe(false);
  });
});

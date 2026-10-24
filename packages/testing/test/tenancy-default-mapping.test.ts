import { describe, expect, it } from "vitest";
import { PATH_PARAMETER_MAPPING, classifyOperations, kindOfParameter, loadOpenApiDocument, type PathParameterMapping } from "../src/tenancy.ts";

// The default mapping `runApiMatrix` uses when a composition passes none must
// name every identifier-carrying input of the bookmark operations of the
// committed contract, so a matrix run over `openapi.json` does not report "no
// fixture" for one. The members and invitations operations are mapped by the
// suites that hold a fixture with those rows (see mapping.ts).

/** The path, query and body inputs of every bookmark operation that the matrix classifies as identifier-carrying, as `<operationId>.<name>`. */
function bookmarkInputs(): string[] {
  const classification = classifyOperations(loadOpenApiDocument());
  expect(classification.problems).toEqual([]);
  return classification.operations
    .filter((operation) => operation.kind === "tenant-scoped" && operation.path.startsWith("/api/v1/bookmarks"))
    .flatMap((operation) => [
      ...operation.pathParameters.map((name) => ({ operationId: operation.operationId, name })),
      ...operation.inputs.map(({ name }) => ({ operationId: operation.operationId, name })),
    ])
    .map(({ operationId, name }) => `${operationId}.${name}`);
}

/** The inputs of `inputs` that `mapping` has no entry for, by the key of the operation or by the name alone. */
function unmapped(inputs: readonly string[], mapping: PathParameterMapping): string[] {
  return inputs.filter((input) => {
    const [operationId = "", ...rest] = input.split(".");
    return kindOfParameter(mapping, operationId, rest.join(".")) === undefined;
  });
}

describe("PATH_PARAMETER_MAPPING", () => {
  it("finds the identifier-carrying inputs of the bookmark operations in the committed contract", () => {
    expect(bookmarkInputs()).toEqual(
      expect.arrayContaining(["openBookmark.id", "listBookmarks.hasSlug", "listBookmarkIds.hasSlug", "bulkBookmarks.ids[]", "bulkBookmarks.filter.hasSlug"]),
    );
  });

  it("has an entry for every identifier-carrying input of the bookmark operations in the committed contract", () => {
    expect(unmapped(bookmarkInputs(), PATH_PARAMETER_MAPPING)).toEqual([]);
  });

  it("names an input that has no entry", () => {
    const without = Object.fromEntries(Object.entries(PATH_PARAMETER_MAPPING).filter(([key]) => key !== "openBookmark.id"));
    expect(unmapped(bookmarkInputs(), without)).toEqual(["openBookmark.id"]);
  });

  it("maps the bookmark inputs to a bookmark", () => {
    for (const input of bookmarkInputs()) {
      expect(PATH_PARAMETER_MAPPING[input]).toBe("bookmark");
    }
  });
});

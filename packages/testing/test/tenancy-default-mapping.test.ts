import { describe, expect, it } from "vitest";
import { PATH_PARAMETER_MAPPING, classifyOperations, kindOfParameter, loadOpenApiDocument, type IdentifierKind, type PathParameterMapping } from "../src/tenancy.ts";

// The default mapping `runApiMatrix` uses when a composition passes none must
// name every identifier-carrying input of every tenant-scoped operation of the
// committed contract, so a matrix run over `openapi.json` does not report "no
// fixture" for one.

/** The path, query and body inputs of every tenant-scoped operation that the matrix classifies as identifier-carrying, as `<operationId>.<name>`. */
function contractInputs(): string[] {
  const classification = classifyOperations(loadOpenApiDocument());
  expect(classification.problems).toEqual([]);
  return classification.operations
    .filter((operation) => operation.kind === "tenant-scoped")
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
  it("finds the identifier-carrying inputs of the bookmark, tag, folder, member and invitation operations in the committed contract", () => {
    expect(contractInputs()).toEqual(
      expect.arrayContaining([
        "openBookmark.id",
        "renameTag.id",
        "deleteTag.id",
        "mergeTag.id",
        "mergeTag.intoTagId",
        "getFolder.id",
        "updateFolder.id",
        "deleteFolder.id",
        "addFolderBookmarks.id",
        "addFolderBookmarks.bookmarkIds[]",
        "removeFolderBookmarks.id",
        "removeFolderBookmarks.bookmarkIds[]",
        "listBookmarks.folderId",
        "createBookmark.folderIds[]",
        "updateBookmark.folderIds[]",
        "listBookmarks.tag",
        "listBookmarks.tag[]",
        "createBookmark.tagIds[]",
        "updateBookmark.tagIds[]",
        "listBookmarks.hasSlug",
        "listBookmarkIds.hasSlug",
        "listBookmarkIds.folderId",
        "listBookmarkIds.tag",
        "listBookmarkIds.tag[]",
        "bulkBookmarks.ids[]",
        "bulkBookmarks.filter.hasSlug",
        "bulkBookmarks.filter.folderId",
        "bulkBookmarks.filter.tag",
        "bulkBookmarks.filter.tag[]",
        "bulkBookmarks.folderId",
        "bulkBookmarks.tagIds[]",
        "previewBulkBookmarks.ids[]",
        "previewBulkBookmarks.filter.hasSlug",
        "previewBulkBookmarks.filter.folderId",
        "previewBulkBookmarks.filter.tag",
        "previewBulkBookmarks.filter.tag[]",
        "previewBulkBookmarks.tagIds[]",
        "createInvitation.teamIds[]",
        "revokeInvitation.id",
        "createInvitationLink.id",
        "resendInvitation.id",
        "removeMember.accountId",
        "removeMember.transferTo",
        "updateMember.accountId",
        "leaveWorkspace.transferTo",
        "transferWorkspaceOwnership.accountId",
      ]),
    );
  });

  it("has an entry for every identifier-carrying input of every tenant-scoped operation in the committed contract", () => {
    expect(unmapped(contractInputs(), PATH_PARAMETER_MAPPING)).toEqual([]);
  });

  it("names an input that has no entry", () => {
    const without = Object.fromEntries(Object.entries(PATH_PARAMETER_MAPPING).filter(([key]) => key !== "openBookmark.id" && key !== "removeMember.transferTo"));
    expect(unmapped(contractInputs(), without)).toEqual(["openBookmark.id", "removeMember.transferTo"]);
  });

  it("maps each input to the kind of fixture identifier it takes", () => {
    const expected: Record<string, IdentifierKind> = {
      "renameTag.id": "tag",
      "deleteTag.id": "tag",
      "mergeTag.id": "tag",
      "mergeTag.intoTagId": "tag",
      "getFolder.id": "folder",
      "updateFolder.id": "folder",
      "deleteFolder.id": "folder",
      "addFolderBookmarks.id": "folder",
      "removeFolderBookmarks.id": "folder",
      "listBookmarks.folderId": "folder",
      "createBookmark.folderIds[]": "folder",
      "updateBookmark.folderIds[]": "folder",
      "listBookmarks.tag": "tag",
      "listBookmarks.tag[]": "tag",
      "createBookmark.tagIds[]": "tag",
      "updateBookmark.tagIds[]": "tag",
      "listBookmarkIds.folderId": "folder",
      "listBookmarkIds.tag": "tag",
      "listBookmarkIds.tag[]": "tag",
      "bulkBookmarks.filter.folderId": "folder",
      "bulkBookmarks.filter.tag": "tag",
      "bulkBookmarks.filter.tag[]": "tag",
      "bulkBookmarks.folderId": "folder",
      "bulkBookmarks.tagIds[]": "tag",
      "previewBulkBookmarks.filter.folderId": "folder",
      "previewBulkBookmarks.filter.tag": "tag",
      "previewBulkBookmarks.filter.tag[]": "tag",
      "previewBulkBookmarks.tagIds[]": "tag",
      "createInvitation.teamIds[]": "team",
      "revokeInvitation.id": "invitation",
      "createInvitationLink.id": "invitation",
      "resendInvitation.id": "invitation",
      "removeMember.accountId": "member",
      "removeMember.transferTo": "member",
      "updateMember.accountId": "member",
      "leaveWorkspace.transferTo": "member",
      "transferWorkspaceOwnership.accountId": "member",
    };
    for (const input of contractInputs()) {
      const kind = expected[input] ?? "bookmark";
      expect(PATH_PARAMETER_MAPPING[input], input).toBe(kind);
    }
  });
});

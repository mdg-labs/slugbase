import { describe, expect, it } from "vitest";
import { acceptedVersions, entityTagOf } from "../../src/routes/workspaces/if-match.ts";

describe("entityTagOf", () => {
  it("quotes the version", () => {
    expect(entityTagOf(3)).toBe('"3"');
  });
});

describe("acceptedVersions", () => {
  it("makes no precondition of an absent header and of *", () => {
    expect(acceptedVersions(undefined)).toBeUndefined();
    expect(acceptedVersions("*")).toBeUndefined();
    expect(acceptedVersions(" * ")).toBeUndefined();
  });

  it("reads the strong entity tags of the header, in a list as well", () => {
    expect(acceptedVersions('"3"')).toEqual([3]);
    expect(acceptedVersions('"3", "4" ,"10"')).toEqual([3, 4, 10]);
  });

  it("accepts no version for a header it cannot read, so the change is refused and not passed", () => {
    for (const header of ["", "3", 'W/"3"', '"abc"', '"-1"', '"3', '"1234567890"', "* , *"]) {
      expect(acceptedVersions(header), header).toEqual([]);
    }
  });
});

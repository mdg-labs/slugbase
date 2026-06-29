import { describe, expect, it } from "vitest";

import {
  listReleaseServiceTags,
  parseCeServiceTag,
} from "./list-release-service-tags.mjs";

describe("list-release-service-tags", () => {
  it("parseCeServiceTag accepts slugbase-api/web v* tags only", () => {
    expect(parseCeServiceTag("slugbase-api/v1.0.1")).toEqual({
      service: "api",
      version: "1.0.1",
    });
    expect(parseCeServiceTag("slugbase-web/v2.3.4")).toEqual({
      service: "web",
      version: "2.3.4",
    });
    expect(parseCeServiceTag("slugbase-marketing/v1.0.0")).toBeNull();
    expect(parseCeServiceTag("release-2026-06-29")).toBeNull();
  });

  it("enables CE push when api/web service tags are at 1.0.0+", () => {
    expect(
      listReleaseServiceTags([
        "release-2026-06-29",
        "slugbase-api/v1.0.1",
        "slugbase-web/v1.0.0",
      ]),
    ).toEqual({
      push_ghcr_api: true,
      push_ghcr_web: true,
      skipped_below_floor: [],
      api_tag: "slugbase-api/v1.0.1",
      web_tag: "slugbase-web/v1.0.0",
    });
  });

  it("skips CE :latest when service tag semver is below 1.0.0", () => {
    expect(
      listReleaseServiceTags(["release-2026-06-29", "slugbase-api/v0.9.0"]),
    ).toEqual({
      push_ghcr_api: false,
      push_ghcr_web: false,
      skipped_below_floor: ["slugbase-api/v0.9.0"],
      api_tag: null,
      web_tag: null,
    });
  });

  it("ignores marketing/admin service tags (no CE image surfaces)", () => {
    expect(
      listReleaseServiceTags([
        "slugbase-marketing/v1.2.3",
        "slugbase-admin/v1.0.0",
      ]),
    ).toEqual({
      push_ghcr_api: false,
      push_ghcr_web: false,
      skipped_below_floor: [],
      api_tag: null,
      web_tag: null,
    });
  });

  it("returns no CE jobs when release commit has no CE service tags", () => {
    expect(listReleaseServiceTags(["release-2026-06-29"])).toEqual({
      push_ghcr_api: false,
      push_ghcr_web: false,
      skipped_below_floor: [],
      api_tag: null,
      web_tag: null,
    });
  });
});

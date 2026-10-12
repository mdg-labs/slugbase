import { readFileSync } from "node:fs";
import { VersionInfoSchema } from "@slugbase/contracts";
import type { z } from "zod";

/** What `GET /version` answers with, and nothing else (doc 10, T22). */
export type BuildInfo = z.output<typeof VersionInfoSchema>;

/** What a build without a build-info file reports: a development run from source. */
export const DEVELOPMENT_BUILD_INFO: BuildInfo = Object.freeze({
  name: "SlugBase",
  version: "0.0.0-development",
  commit: "development",
  builtAt: "1970-01-01T00:00:00Z",
});

/**
 * Reads the build-info file the image build writes. A file that does not exist
 * is a development run and reports `DEVELOPMENT_BUILD_INFO`; a file that exists
 * but cannot be read or does not hold the four fields throws, so a broken build
 * does not start under the identity of a development one. Members beyond the
 * four are ignored, so the file can never widen what `/version` reveals.
 */
export function loadBuildInfo(file: URL | string): BuildInfo {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return DEVELOPMENT_BUILD_INFO;
    }
    throw new Error("the build-info file cannot be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the build-info file is not valid JSON");
  }
  const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const result = VersionInfoSchema.safeParse({
    name: fields["name"],
    version: fields["version"],
    commit: fields["commit"],
    builtAt: fields["builtAt"],
  });
  if (!result.success) {
    throw new Error("the build-info file must hold the string members name, version, commit and builtAt");
  }
  return Object.freeze(result.data);
}

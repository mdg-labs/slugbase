import { execFileSync } from "node:child_process";

export const PRODUCT_NAME = "SlugBase";

/** The file `GET /version` reads: exactly the four members of the version contract. */
export interface BuildInfoFile {
  name: string;
  version: string;
  commit: string;
  builtAt: string;
}

export interface BuildInfoInput {
  version: string;
  commit: string;
  now: Date;
}

export function renderBuildInfo({ version, commit, now }: BuildInfoInput): BuildInfoFile {
  if (version === "" || commit === "") {
    throw new Error("the build info needs a version and a commit");
  }
  return { name: PRODUCT_NAME, version, commit, builtAt: now.toISOString().replace(/\.\d{3}Z$/, "Z") };
}

/**
 * The source revision being built: `BUILD_COMMIT` when the build runs where no
 * git checkout exists (an image build context), else `HEAD` of the checkout. A
 * build that knows neither stops instead of reporting a revision it made up.
 */
export function sourceCommit(env: NodeJS.ProcessEnv, cwd: string): string {
  const given = env["BUILD_COMMIT"];
  if (given !== undefined && given !== "") {
    return given;
  }
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (head !== "") {
      return head;
    }
  } catch {
    // Falls through to the error below, which names both ways to supply the revision.
  }
  throw new Error("cannot tell the source revision: build inside a git checkout or set BUILD_COMMIT");
}

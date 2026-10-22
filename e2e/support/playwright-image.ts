/** The Playwright image a Dockerfile starts from: the version in its tag and the digest that pins it. */
export interface PlaywrightImage {
  version: string;
  digest: string;
}

const FROM_LINE = /^FROM\s+mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-[a-z]+@(sha256:[0-9a-f]{64})\s*$/;

/**
 * Reads the image of the only `FROM` line of e2e/Dockerfile. It throws when the line is not the
 * official Playwright image at an exact version and a digest, so a floating tag cannot pass.
 */
export function parsePlaywrightImage(dockerfile: string): PlaywrightImage {
  const lines = dockerfile.split("\n").filter((line) => /^FROM\s/i.test(line));
  const line = lines[0];
  if (lines.length !== 1 || line === undefined) {
    throw new Error(`expected exactly one FROM line, found ${String(lines.length)}`);
  }
  const match = FROM_LINE.exec(line);
  const version = match?.[1];
  const digest = match?.[2];
  if (version === undefined || digest === undefined) {
    throw new Error(`the FROM line must be mcr.microsoft.com/playwright:v<version>-<distribution>@sha256:<digest>: ${line}`);
  }
  return { version, digest };
}

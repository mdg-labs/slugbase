// Node.js 24.2.0 is the first release with `import.meta.main`, which the
// direct-entry checks in apps/slugbase and tooling rely on.
export const REQUIRED_MAJOR = 24;
export const MINIMUM_MINOR = 2;
export const REQUIRED_RANGE = `>=${REQUIRED_MAJOR}.${MINIMUM_MINOR}.0 <${REQUIRED_MAJOR + 1}.0.0`;

/**
 * @param {string} version a Node.js version such as `process.versions.node`
 * @returns {boolean} whether it is inside `REQUIRED_RANGE`
 */
export function isSupportedNode(version) {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major === REQUIRED_MAJOR && minor !== undefined && minor >= MINIMUM_MINOR;
}

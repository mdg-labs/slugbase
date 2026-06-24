/**
 * Live /version probe for deploy planning (ci-cd refactor #549).
 */

export const BOOTSTRAP_VERSION = "0.0.0";

/** @typedef {'staging' | 'production'} DeployEnvironment */

/**
 * @typedef {object} ProbeVersionResult
 * @property {string} liveVersion
 * @property {boolean} bootstrapped
 * @property {number} [httpStatus]
 */

/**
 * @typedef {object} ProbeVersionOptions
 * @property {string} origin
 * @property {DeployEnvironment} environment
 * @property {string} [cfAccessClientId]
 * @property {string} [cfAccessClientSecret]
 * @property {typeof fetch} [fetchFn]
 * @property {number} [maxAttempts]
 * @property {number} [initialDelayMs]
 */

/**
 * @param {string} version
 * @returns {[number, number, number] | null}
 */
export function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function semverGt(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) {
      return true;
    }
    if (a[i] < b[i]) {
      return false;
    }
  }
  return false;
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function semverGte(left, right) {
  return left === right || semverGt(left, right);
}

/**
 * @param {number} status
 * @param {DeployEnvironment} environment
 * @returns {'ok' | 'bootstrap' | 'fail'}
 */
export function classifyProbeStatus(status, environment) {
  if (status === 403 && environment === "staging") {
    return "fail";
  }
  if (status === 200) {
    return "ok";
  }
  if (
    status === 404 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 0
  ) {
    return "bootstrap";
  }
  return "bootstrap";
}

/**
 * @param {unknown} body
 * @returns {string | null}
 */
export function parseVersionBody(body) {
  if (!body || typeof body !== "object") {
    return null;
  }
  const version = /** @type {{ version?: unknown }} */ (body).version;
  return typeof version === "string" && version.trim() ? version.trim() : null;
}

/**
 * @param {number} attempt
 * @param {number} initialDelayMs
 * @returns {Promise<void>}
 */
export async function backoff(attempt, initialDelayMs) {
  const delay = initialDelayMs * 2 ** Math.max(0, attempt - 1);
  await new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

/**
 * @param {ProbeVersionOptions} options
 * @returns {Promise<ProbeVersionResult>}
 */
export async function probeLiveVersion(options) {
  const fetchFn = options.fetchFn ?? fetch;
  const maxAttempts = options.maxAttempts ?? 4;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const origin = options.origin.replace(/\/$/, "");
  const url = `${origin}/version`;

  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (options.environment === "staging") {
    headers["CF-Access-Client-Id"] = options.cfAccessClientId ?? "";
    headers["CF-Access-Client-Secret"] = options.cfAccessClientSecret ?? "";
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let status = 0;
    try {
      const response = await fetchFn(url, { headers, method: "GET" });
      status = response.status;
      const kind = classifyProbeStatus(status, options.environment);

      if (kind === "fail") {
        throw new Error(
          `probe-version: ${url} returned HTTP 403 on staging — check CF Access service token credentials`,
        );
      }

      if (kind === "ok") {
        let body;
        try {
          body = await response.json();
        } catch {
          throw new Error(`probe-version: ${url} returned invalid JSON`);
        }
        const liveVersion = parseVersionBody(body);
        if (!liveVersion) {
          throw new Error(`probe-version: ${url} missing version field`);
        }
        return { liveVersion, bootstrapped: false, httpStatus: status };
      }

      if (attempt === maxAttempts) {
        return {
          liveVersion: BOOTSTRAP_VERSION,
          bootstrapped: true,
          httpStatus: status,
        };
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("returned HTTP 403 on staging")
      ) {
        throw error;
      }
      if (attempt === maxAttempts) {
        return {
          liveVersion: BOOTSTRAP_VERSION,
          bootstrapped: true,
          httpStatus: status,
        };
      }
    }

    await backoff(attempt, initialDelayMs);
  }

  return {
    liveVersion: BOOTSTRAP_VERSION,
    bootstrapped: true,
    httpStatus: 0,
  };
}

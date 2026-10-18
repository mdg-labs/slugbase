const TOKEN_MAX_LENGTH = 256;

/**
 * The token of a verification link, from the fragment of its address (`#token=…`). The fragment never reaches a
 * server log or a `Referer`; a missing, empty or over-long token is no token.
 */
export function tokenFromFragment(fragment: string): string | undefined {
  const token = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment).get("token");
  return token === null || token === "" || token.length > TOKEN_MAX_LENGTH ? undefined : token;
}

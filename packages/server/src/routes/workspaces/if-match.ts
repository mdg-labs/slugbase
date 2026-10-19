// The `If-Match` precondition of doc 04 section 2.4, for a record whose `ETag` is its version as a quoted
// entity tag (`"3"`). `If-Match` compares strongly (RFC 9110), so only a quoted tag counts; a weak tag, a
// tag that is not a version and an empty header name no version at all. The answer is the versions the
// caller accepts, so that a header the server cannot read refuses the change instead of passing it.

const ENTITY_TAG = /^"(\d{1,9})"$/;

/** The `ETag` value of a record at `version`. */
export function entityTagOf(version: number): string {
  return `"${String(version)}"`;
}

/**
 * The versions an `If-Match` header accepts. Undefined when the request makes no precondition: the header is
 * absent, or it is `*`, which matches any current version of a record that exists. Otherwise the versions of
 * its strong entity tags, none when it holds nothing the server can read.
 */
export function acceptedVersions(header: string | undefined): readonly number[] | undefined {
  if (header === undefined) {
    return undefined;
  }
  const tags = header.split(",").map((tag) => tag.trim());
  if (tags.length === 1 && tags[0] === "*") {
    return undefined;
  }
  const versions: number[] = [];
  for (const tag of tags) {
    const match = ENTITY_TAG.exec(tag);
    if (match?.[1] !== undefined) {
      versions.push(Number(match[1]));
    }
  }
  return versions;
}

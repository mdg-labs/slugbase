import type { Person, World } from "../workspaces/support.ts";

// The requests of the tests of POST /api/v1/import/netscape: a browser's bookmark file sent as the multipart upload the application's own page makes, and a multipart body written by hand for the
// bodies a browser would never send.

export const NETSCAPE = "/api/v1/import/netscape";

export interface UploadOptions {
  /** The path with its query; the import path by default. */
  readonly path?: string;
  /** Headers added to, and overriding, the session cookie and the application's origin. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The name of the file part; `file`. */
  readonly field?: string;
  readonly filename?: string;
  /** Parts besides the file, in order after it. */
  readonly extra?: readonly (readonly [string, string | Blob])[];
  /** The cookie of the request; the person's. `null` sends none. */
  readonly cookie?: string | null;
}

/**
 * The request that uploads `content` as the one file of a form. The form is serialised first and sent as the bytes it is, with the boundary its serialiser chose, so that the request has a length and a
 * server that stops reading it (the body limit) does not leave the runtime's form encoder writing into a stream that is closed.
 */
export async function uploadRequest(world: World, person: Person, content: string | Uint8Array, options: UploadOptions = {}): Promise<Request> {
  const form = new FormData();
  form.set(options.field ?? "file", new File([content], options.filename ?? "bookmarks.html", { type: "text/html" }));
  for (const [name, value] of options.extra ?? []) {
    form.append(name, value);
  }
  const cookie = options.cookie === undefined ? person.cookie : options.cookie;
  const serialised = new Response(form);
  const body = new Uint8Array(await serialised.arrayBuffer());
  return new Request(new URL(options.path ?? NETSCAPE, world.origin), {
    method: "POST",
    headers: { origin: world.origin, "content-type": serialised.headers.get("content-type") ?? "", ...(cookie === null ? {} : { cookie }), ...options.headers },
    body,
  });
}

export const upload = async (world: World, person: Person, content: string | Uint8Array, options: UploadOptions = {}): Promise<Response> =>
  world.server.fetch(await uploadRequest(world, person, content, options));

/** A multipart body written by hand, sent with `contentType`; the application's origin and the person's cookie go along. */
export function multipart(world: World, person: Person, body: string | Uint8Array, contentType: string, headers: Readonly<Record<string, string>> = {}, path = NETSCAPE): Promise<Response> {
  return world.server.fetch(
    new Request(new URL(path, world.origin), { method: "POST", headers: { origin: world.origin, cookie: person.cookie, "content-type": contentType, ...headers }, body }),
  );
}

export interface FileLink {
  readonly url: string;
  readonly title?: string;
  readonly folder?: string;
  readonly tags?: readonly string[];
}

/** A browser bookmark file of the links, each in its own folder when it names one. */
export function bookmarkFile(links: readonly FileLink[]): string {
  const escaped = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const entry = (link: FileLink): string => `<DT><A HREF="${escaped(link.url)}"${link.tags === undefined ? "" : ` TAGS="${escaped(link.tags.join(","))}"`}>${escaped(link.title ?? "")}</A>\n`;
  const folders = [...new Set(links.flatMap((link) => (link.folder === undefined ? [] : [link.folder])))];
  return [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n",
    ...links.filter((link) => link.folder === undefined).map(entry),
    ...folders.map((folder) => `<DT><H3>${escaped(folder)}</H3>\n<DL><p>\n${links.filter((link) => link.folder === folder).map(entry).join("")}</DL><p>\n`),
    "</DL><p>\n",
  ].join("");
}

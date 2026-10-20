// The mail the stack sent, read back from the HTTP API of Mailpit (E2E_MAILPIT_URL, set by
// e2e/with-stack.sh): every mail of the server and the worker lands there, whoever it is addressed to.

const POLL_MS = 500;
const WAIT_MS = 30_000;

export interface Mail {
  readonly subject: string;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mailpitUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.E2E_MAILPIT_URL;
  if (url === undefined || url === "") {
    throw new Error("E2E_MAILPIT_URL is not set; run the journeys through `bash e2e/with-stack.sh pnpm test:e2e`");
  }
  return url;
}

async function getJson(base: string, path: string): Promise<unknown> {
  const response = await fetch(new URL(path, base));
  if (!response.ok) {
    throw new Error(`GET ${path} of Mailpit answered ${String(response.status)}`);
  }
  return (await response.json()) as unknown;
}

/** The ids of the mails addressed to `address`, newest first. */
async function idsOf(base: string, address: string): Promise<string[]> {
  const found = await getJson(base, `/api/v1/search?${new URLSearchParams({ query: `to:"${address}"` }).toString()}`);
  const messages = isRecord(found) ? found.messages : undefined;
  if (!Array.isArray(messages)) {
    throw new Error("the search of Mailpit answered without a list of messages");
  }
  return messages.map((message: unknown) => {
    const id = isRecord(message) ? message.ID : undefined;
    if (typeof id !== "string" || id === "") {
      throw new Error("the search of Mailpit listed a message without an id");
    }
    return id;
  });
}

async function mailOf(base: string, id: string): Promise<Mail> {
  const message = await getJson(base, `/api/v1/message/${encodeURIComponent(id)}`);
  const subject = isRecord(message) ? message.Subject : undefined;
  const text = isRecord(message) ? message.Text : undefined;
  if (typeof subject !== "string" || typeof text !== "string") {
    throw new Error("Mailpit answered a message without a subject and a text part");
  }
  return { subject, text };
}

/**
 * Waits for the first mail addressed to `address`, at most 30 seconds, and returns the newest one. A
 * journey uses an address of its own, so the mail found is the one it caused; none arriving is an error,
 * not an empty result.
 */
export async function waitForMail(address: string, base: string = mailpitUrl()): Promise<Mail> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const [newest] = await idsOf(base, address);
    if (newest !== undefined) {
      return mailOf(base, newest);
    }
    if (Date.now() >= deadline) {
      throw new Error(`no mail for ${address} reached Mailpit within ${String(WAIT_MS / 1000)} seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The invitation link of a mail's text: the one link under `<origin>/invite/` that it holds. */
export function invitationLink(text: string, origin: string): string {
  const prefix = `${origin.replace(/\/+$/, "")}/invite/`;
  const links = [...new Set(text.split(/\s+/).filter((word) => word.startsWith(prefix) && word.length > prefix.length))];
  const [link] = links;
  if (link === undefined || links.length > 1) {
    throw new Error(`the mail holds ${String(links.length)} links under ${prefix}, not one`);
  }
  return link;
}

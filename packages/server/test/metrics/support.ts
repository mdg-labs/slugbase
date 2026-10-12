import { connect } from "node:net";

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** One request over a raw socket: the repository allows no HTTP client outside the egress adapter. */
export function get(port: number, path: string, method = "GET"): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const separator = text.indexOf("\r\n\r\n");
      const [statusLine = "", ...headerLines] = text.slice(0, separator).split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      const chunked = headers["transfer-encoding"] === "chunked";
      const raw = text.slice(separator + 4);
      resolve({ status: Number(statusLine.split(" ")[1]), headers, body: chunked ? dechunk(raw) : raw });
    });
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}

function dechunk(raw: string): string {
  let rest = raw;
  let body = "";
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (lineEnd < 0 || Number.isNaN(size) || size === 0) {
      return body;
    }
    body += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

/** The value of the sample `name{labels}` in an exposition text, or undefined. */
export function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  const wanted = Object.entries(labels).map(([key, value]) => `${key}="${value}"`);
  for (const line of text.split("\n")) {
    if (!line.startsWith(name) || line.startsWith("#")) {
      continue;
    }
    const rest = line.slice(name.length);
    if (!rest.startsWith("{") && !rest.startsWith(" ")) {
      continue;
    }
    if (wanted.every((pair) => line.includes(pair))) {
      return Number(line.slice(line.lastIndexOf(" ") + 1));
    }
  }
  return undefined;
}

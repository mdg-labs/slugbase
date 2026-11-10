import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { request } from "node:https";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// What the reverse proxy drill (e2e/reverse-proxy.spec.ts) needs besides Playwright: the configuration blocks of
// docs/self-hosting/reverse-proxy.md, taken from the guide itself, the two proxies that run them (images pinned in
// e2e/compose.proxy.yml, started with `docker run` on the host's network so that each client has an address of its
// own as the proxy sees it), and a client of the proxy's https origin that can choose the address it connects from
// and trusts the certificate of the test only.
//
// The only changes a block gets before it runs are the ones the guide itself asks an operator to make: the host name
// and the certificate paths, which are the same here, and the ports, which are free ports of this host instead of 80,
// 443 and 3000. Each change is a literal text that must occur exactly once, so a guide that no longer has the line
// fails the drill instead of being run in some other shape.

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const GUIDE = join(REPOSITORY_ROOT, "docs", "self-hosting", "reverse-proxy.md");
const PROXY_IMAGES = join(REPOSITORY_ROOT, "e2e", "compose.proxy.yml");

/** The label of every container the drill starts, which the workflow removes by when a run dies. */
export const PROXY_LABEL = "slugbase-e2e-proxy";
const COMMAND_MS = 2 * 60_000;
const REQUEST_MS = 15_000;
const POLL_MS = 500;

export interface FencedBlock {
  /** The word after the opening fence. */
  info: string;
  body: string;
}

/** The fenced code blocks of a Markdown text, in order. */
export function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { info: string; lines: string[] } | undefined;
  for (const line of markdown.split("\n")) {
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence === null) {
      open?.lines.push(line);
    } else if (open === undefined) {
      open = { info: fence[1] ?? "", lines: [] };
    } else {
      blocks.push({ info: open.info, body: `${open.lines.join("\n")}\n` });
      open = undefined;
    }
  }
  if (open !== undefined) {
    throw new Error("a fenced block of the guide is not closed");
  }
  return blocks;
}

/** The one block with this info word that holds `marker`; the guide has other blocks of the same kind. */
function onlyBlock(blocks: readonly FencedBlock[], info: string, marker: string): string {
  const found = blocks.filter((block) => block.info === info && block.body.includes(marker));
  if (found.length !== 1) {
    throw new Error(`the guide has ${String(found.length)} \`${info}\` blocks with '${marker}', and the drill needs exactly one`);
  }
  return found[0]?.body ?? "";
}

export interface GuideConfigs {
  /** The whole nginx site file. */
  nginx: string;
  /** The whole Caddyfile. */
  caddy: string;
  /** The global options block for a Caddy that sits behind another proxy. */
  caddyGlobal: string;
  /** The `TRUSTED_PROXY_HOPS` the files' own comments give for one proxy in front of SlugBase. */
  hops: number;
  /** The paths the nginx file loads its certificate and key from. */
  nginxCertificate: string;
  nginxCertificateKey: string;
}

function hopsOf(config: string, what: string): number {
  const found = /TRUSTED_PROXY_HOPS=(\d+)/.exec(config);
  if (found === null) {
    throw new Error(`the ${what} file of the guide does not say which TRUSTED_PROXY_HOPS it needs`);
  }
  return Number(found[1]);
}

function directive(config: string, name: string): string {
  const found = new RegExp(`^\\s*${name}\\s+(\\S+);`, "m").exec(config);
  if (found === null) {
    throw new Error(`the nginx file of the guide has no ${name}`);
  }
  return found[1] ?? "";
}

/** The complete nginx and Caddy files of the guide, and the number of hops they say they need. */
export function guideConfigs(markdown: string): GuideConfigs {
  const blocks = fencedBlocks(markdown);
  const nginx = onlyBlock(blocks, "nginx", "upstream slugbase");
  const caddy = onlyBlock(blocks, "caddyfile", "reverse_proxy");
  const caddyGlobal = onlyBlock(blocks, "caddyfile", "trusted_proxies");
  const hops = hopsOf(nginx, "nginx");
  if (hopsOf(caddy, "Caddy") !== hops) {
    throw new Error("the nginx file and the Caddyfile of the guide name different numbers of hops");
  }
  return { nginx, caddy, caddyGlobal, hops, nginxCertificate: directive(nginx, "ssl_certificate"), nginxCertificateKey: directive(nginx, "ssl_certificate_key") };
}

/** Replaces a text that must occur exactly once. */
export function replaceOnce(config: string, from: string, to: string): string {
  const parts = config.split(from);
  if (parts.length !== 2) {
    throw new Error(`the guide's configuration holds '${from}' ${String(parts.length - 1)} times, and the drill needs exactly one`);
  }
  return parts.join(to);
}

export interface Ports {
  /** Where the proxy serves https. */
  tls: number;
  /** Where nginx serves the redirect to https, and Caddy its own http listener. */
  http: number;
  /** The port the SlugBase server is published on, on 127.0.0.1. */
  upstream: number;
}

/**
 * The guide's nginx file with this host's ports. It listens on the loopback address only and on IPv4 only, as the host of a
 * drill may have no IPv6; the host name, the certificate paths and everything else are the guide's.
 */
export function nginxConfig(config: string, ports: Ports): string {
  let result = replaceOnce(config, "server 127.0.0.1:3000;", `server 127.0.0.1:${String(ports.upstream)};`);
  result = replaceOnce(result, "    listen 80;\n", `    listen 127.0.0.1:${String(ports.http)};\n`);
  result = replaceOnce(result, "    listen [::]:80;\n", "");
  result = replaceOnce(result, "    listen 443 ssl;\n", `    listen 127.0.0.1:${String(ports.tls)} ssl;\n`);
  return replaceOnce(result, "    listen [::]:443 ssl;\n", "");
}

/**
 * The guide's Caddyfile for a host name that is the loopback address, which Caddy gives a certificate of its own CA, with this
 * host's ports in a global block that turns the admin endpoint off. The reverse_proxy line, the body limit and every comment are the guide's.
 */
export function caddyConfig(config: string, ports: Ports): string {
  const site = replaceOnce(replaceOnce(config, "links.example.com {", "127.0.0.1 {"), "reverse_proxy 127.0.0.1:3000", `reverse_proxy 127.0.0.1:${String(ports.upstream)}`);
  return `{\n\tadmin off\n\thttp_port ${String(ports.http)}\n\thttps_port ${String(ports.tls)}\n}\n\n${site}`;
}

/** The image of a service of e2e/compose.proxy.yml, which must be named by a digest. */
export function proxyImage(service: "nginx" | "caddy", compose: string = readFileSync(PROXY_IMAGES, "utf8")): string {
  const section = new RegExp(`^  ${service}:\\n((?:    .*\\n)+)`, "m").exec(compose);
  const image = section === null ? null : /^ {4}image:\s*(\S+)\s*$/m.exec(section[1] ?? "");
  const name = image?.[1];
  if (name === undefined || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(name)) {
    throw new Error(`e2e/compose.proxy.yml does not name the image of ${service} by a sha256 digest`);
  }
  return name;
}

/** A port of this host that nothing listens on, in the range below the ephemeral ports where a listener cannot collide with an outbound socket. */
export async function freePort(avoid: readonly number[] = []): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 20_000 + Math.floor(Math.random() * 12_768);
    if (avoid.includes(candidate)) {
      continue;
    }
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => {
        resolve(false);
      });
      probe.listen(candidate, "127.0.0.1", () => {
        probe.close(() => {
          resolve(true);
        });
      });
    });
    if (free) {
      return candidate;
    }
  }
  throw new Error("no free port found on 127.0.0.1");
}

export interface DockerResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** `docker` with a bound on its time; a command that fails throws with the end of its error output unless `allowFailure`. */
export function docker(args: readonly string[], options: { allowFailure?: boolean } = {}): DockerResult {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: COMMAND_MS });
  if (result.error !== undefined) {
    throw new Error(`docker ${args[0] ?? ""} could not run: ${result.error.message}`);
  }
  const status = result.status ?? 1;
  if (status !== 0 && options.allowFailure !== true) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} ended with status ${String(status)}:\n${result.stderr.trim().split("\n").slice(-12).join("\n")}`);
  }
  return { status, stdout: result.stdout, stderr: result.stderr };
}

export interface TlsMaterial {
  certFile: string;
  keyFile: string;
}

/** A key and a self-signed certificate for 127.0.0.1, in a directory of its own. */
export function selfSignedCertificate(directory: string): TlsMaterial {
  const keyFile = join(directory, "tls.key");
  const certFile = join(directory, "tls.crt");
  const result = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile],
    { encoding: "utf8", timeout: COMMAND_MS },
  );
  if (result.status !== 0) {
    throw new Error("openssl could not generate the certificate of the test");
  }
  // The proxy's process reads these as another user than this one.
  chmodSync(keyFile, 0o644);
  return { certFile, keyFile };
}

export interface ProxyReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface RequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  /** A JSON body. */
  data?: unknown;
  /** The address to connect from, one of 127.0.0.0/8: it is the client address the proxy sees. */
  from?: string;
}

/** An https origin that is the loopback address and a port, and the certificate authority its answers are checked against. */
export class ProxyClient {
  readonly origin: string;
  private readonly port: number;
  private readonly ca: string;

  constructor(port: number, ca: string) {
    this.port = port;
    this.ca = ca;
    this.origin = `https://127.0.0.1:${String(port)}`;
  }

  send({ method = "GET", path, headers = {}, data, from }: RequestOptions): Promise<ProxyReply> {
    const body = data === undefined ? undefined : JSON.stringify(data);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port: this.port,
          method,
          path,
          ca: this.ca,
          // A connection of its own per request, so that each one is made from the address asked for.
          agent: false,
          timeout: REQUEST_MS,
          ...(from === undefined ? {} : { localAddress: from }),
          headers: { ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }), ...headers },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () => {
            resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") });
          });
          incoming.on("error", reject);
        },
      );
      outgoing.on("timeout", () => {
        outgoing.destroy(new Error(`${method} ${path} did not answer within ${String(REQUEST_MS / 1000)} seconds`));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }
}

/** The values of a response header, which Node gives as text, or as a list for `Set-Cookie`. */
export function headerValues(headers: IncomingHttpHeaders, name: string): string[] {
  const value = headers[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** What the `RateLimit` header says about the bucket `name`: the tokens it has left. */
export function remainingOf(headers: IncomingHttpHeaders, name: string): number | undefined {
  for (const value of headerValues(headers, "ratelimit")) {
    for (const entry of value.split(/,\s*(?=")/)) {
      const found = new RegExp(`^"${name}";r=(\\d+)`).exec(entry.trim());
      if (found !== null) {
        return Number(found[1]);
      }
    }
  }
  return undefined;
}

export interface RunningProxy {
  name: string;
  client: ProxyClient;
  /** The log of the proxy's container. */
  logs: () => string;
  stop: () => void;
}

function removeContainer(name: string): void {
  docker(["rm", "--force", "--volumes", name], { allowFailure: true });
}

function containerRunning(name: string): boolean {
  return docker(["inspect", "--format", "{{.State.Running}}", name], { allowFailure: true }).stdout.trim() === "true";
}

async function waitUntilServing(name: string, port: number, ca: () => string): Promise<ProxyClient> {
  const deadline = Date.now() + 90_000;
  let last = "no answer";
  for (;;) {
    if (!containerRunning(name)) {
      throw new Error(`the container of the proxy stopped before it served:\n${docker(["logs", "--tail", "30", name], { allowFailure: true }).stderr}`);
    }
    try {
      const client = new ProxyClient(port, ca());
      const reply = await client.send({ path: "/ready" });
      if (reply.status === 200) {
        return client;
      }
      last = `status ${String(reply.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "an error";
    }
    if (Date.now() >= deadline) {
      throw new Error(`the proxy did not answer /ready within 90 seconds (last: ${last})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export interface StartOptions {
  /** A directory this drill owns, for the files it hands the proxy. */
  directory: string;
  ports: Ports;
  tls: TlsMaterial;
  configs: GuideConfigs;
}

/** Starts the guide's nginx in front of the server, on the host's network, and waits until it serves https. */
export async function startNginx({ directory, ports, tls, configs }: StartOptions): Promise<RunningProxy> {
  const name = `${PROXY_LABEL}-nginx-${randomBytes(3).toString("hex")}`;
  const confDirectory = join(directory, `nginx-${name}`);
  mkdirSync(confDirectory, { recursive: true, mode: 0o755 });
  // The guide saves the file as /etc/nginx/conf.d/slugbase.conf; the directory holds nothing else, so the image's own default site is not there to take port 80.
  writeFileSync(join(confDirectory, "slugbase.conf"), nginxConfig(configs.nginx, ports), { mode: 0o644 });
  docker([
    "run", "--detach", "--name", name, "--label", PROXY_LABEL, "--network", "host",
    "--volume", `${confDirectory}:/etc/nginx/conf.d:ro`,
    "--volume", `${tls.certFile}:${configs.nginxCertificate}:ro`,
    "--volume", `${tls.keyFile}:${configs.nginxCertificateKey}:ro`,
    proxyImage("nginx"),
  ]);
  try {
    const client = await waitUntilServing(name, ports.tls, () => readFileSync(tls.certFile, "utf8"));
    return { name, client, logs: () => containerLogs(name), stop: () => { removeContainer(name); } };
  } catch (error) {
    removeContainer(name);
    throw error;
  }
}

/** Starts the guide's Caddy in front of the server, on the host's network, and waits until it serves https with the certificate of its own CA. */
export async function startCaddy({ directory, ports, configs }: Omit<StartOptions, "tls">): Promise<RunningProxy> {
  const name = `${PROXY_LABEL}-caddy-${randomBytes(3).toString("hex")}`;
  const file = join(directory, `Caddyfile-${name}`);
  writeFileSync(file, caddyConfig(configs.caddy, ports), { mode: 0o644 });
  docker([
    "run", "--detach", "--name", name, "--label", PROXY_LABEL, "--network", "host",
    "--volume", `${file}:/etc/caddy/Caddyfile:ro`,
    proxyImage("caddy"),
  ]);
  try {
    // The certificate is signed by the root of the CA that Caddy made for itself, which the container holds; it is what the client trusts.
    const root = (): string => docker(["exec", name, "cat", "/data/caddy/pki/authorities/local/root.crt"]).stdout;
    const client = await waitUntilServing(name, ports.tls, root);
    return { name, client, logs: () => containerLogs(name), stop: () => { removeContainer(name); } };
  } catch (error) {
    removeContainer(name);
    throw error;
  }
}

/** Both streams of the container's log: a proxy writes its access log to one and its errors to the other. */
function containerLogs(name: string): string {
  const { stdout, stderr } = docker(["logs", name], { allowFailure: true });
  return `${stdout}${stderr}`;
}

/** Asks Caddy to check the guide's Caddyfile with its global options block for a Caddy behind another proxy in front of it. */
export function validateCaddyBehindProxy(directory: string, configs: GuideConfigs): { status: number; output: string } {
  const file = join(directory, "Caddyfile-behind-proxy");
  writeFileSync(file, `${configs.caddyGlobal}\n${configs.caddy}`, { mode: 0o644 });
  const result = docker(
    ["run", "--rm", "--volume", `${file}:/etc/caddy/Caddyfile:ro`, proxyImage("caddy"), "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
    { allowFailure: true },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

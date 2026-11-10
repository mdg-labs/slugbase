import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compose, type DrillStack } from "./restore-drill.ts";

// What the no-egress drill (e2e/no-egress.spec.ts) needs besides the helpers of the other drills: the compose override that puts the stack on a
// network with no way out and a packet capture in the network namespace of the server and of the worker (e2e/compose.no-egress.yml), the
// reading of what the capture wrote, and the predicate that says whether the instance contacted anything it should not have (Q18, doc 10 T6).
// A message that fails here names a container, a name and an address and never a secret: a capture holds addresses and names.

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The compose override the drill merges over compose.yml. */
export const NO_EGRESS_COMPOSE = join(REPOSITORY_ROOT, "e2e", "compose.no-egress.yml");

/** The services whose network namespace the capture owns, and the capture of each. */
export const CAPTURED = [
  { service: "slugbase", capture: "capture-server" },
  { service: "slugbase-worker", capture: "capture-worker" },
] as const;

/** The names the instance may look up through Docker's resolver: the services of the stack it reaches, which is the database and nothing else. */
export const COMPOSE_NAMES: readonly string[] = ["postgres"];

/** The host of the bookmark the drill saves: a reserved name (RFC 2606) that no resolver answers. */
export const BOOKMARK_HOST = "bookmark.example.test";

/** What a line of the capture says about one packet. */
export interface CaptureRecord {
  /** The container whose network namespace the capture is in. */
  container: string;
  /** Seconds since the epoch, as the capture stamped the packet. */
  at: number;
  from: string;
  to: string;
  toPort: number | undefined;
  protocol: "dns-query" | "tcp" | "icmp" | "datagram";
  /** The type and the name of a DNS question, for a record of that protocol. */
  question: { type: string; name: string } | undefined;
}

export interface ParsedCapture {
  records: CaptureRecord[];
  /** The lines that are not a packet and not something tcpdump says about itself: a capture that cannot be read is no proof. */
  unreadable: string[];
}

/** The lines tcpdump writes about itself, to its standard error, which the log of the container merges with the packets. */
const BANNER = /^(tcpdump: |listening on |\d+ packets? (captured|received by filter|dropped by kernel))/;
const PACKET = /^(\d+\.\d+) +\S+ +(?:In|Out|M|B|P) +IP6? (\S+) > (\S+): (.*)$/;
const IPV4_ENDPOINT = /^(\d+\.\d+\.\d+\.\d+)(?:\.(\d+))?$/;
const IPV6_ENDPOINT = /^([0-9a-fA-F:]+?)(?:\.(\d+))?$/;
/** A DNS question as tcpdump prints it: the id and its flags, optional EDNS, the type with a `?`, the name and the length. */
const DNS_QUESTION = /^\d+\S* (?:\[[^\]]*\] )*([A-Za-z0-9]+)\? (\S+) \(\d+\)$/;

function endpoint(text: string): { address: string; port: number | undefined } | undefined {
  const match = text.includes(":") ? IPV6_ENDPOINT.exec(text) : IPV4_ENDPOINT.exec(text);
  const address = match?.[1];
  if (address === undefined) {
    return undefined;
  }
  return { address, port: match?.[2] === undefined ? undefined : Number(match[2]) };
}

/** The control sequences that `docker compose logs` writes before a line even with `--ansi never`: they are cut, since they are no part of the line. */
const TERMINAL_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Reads the log of one capture container, `tcpdump -n -tt` lines, into records. */
export function parseCapture(container: string, text: string): ParsedCapture {
  const records: CaptureRecord[] = [];
  const unreadable: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.replace(TERMINAL_SEQUENCE, "").replace(/\r$/, "");
    if (trimmed === "" || BANNER.test(trimmed)) {
      continue;
    }
    const packet = PACKET.exec(trimmed);
    const from = endpoint(packet?.[2] ?? "");
    const to = endpoint(packet?.[3] ?? "");
    if (packet === null || from === undefined || to === undefined) {
      unreadable.push(trimmed);
      continue;
    }
    const info = packet[4] ?? "";
    const question = DNS_QUESTION.exec(info);
    records.push({
      container,
      at: Number(packet[1]),
      from: from.address,
      to: to.address,
      toPort: to.port,
      protocol: info.startsWith("Flags [") ? "tcp" : info.startsWith("ICMP") ? "icmp" : question === null ? "datagram" : "dns-query",
      question: question === null ? undefined : { type: question[1] ?? "", name: question[2] ?? "" },
    });
  }
  return { records, unreadable };
}

/** The address as a number, and how many bits it has, or undefined when it is not an address. */
function numeric(address: string): { value: bigint; bits: 32 | 128 } | undefined {
  if (!address.includes(":")) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return undefined;
    }
    return { value: octets.reduce((sum, octet) => sum * 256n + BigInt(octet), 0n), bits: 32 };
  }
  const [head = "", tail, ...extra] = address.split("::");
  if (extra.length > 0) {
    return undefined;
  }
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const first = groups(head);
  const last = tail === undefined ? [] : groups(tail);
  const fill = tail === undefined ? 0 : 8 - first.length - last.length;
  const all = [...first, ...Array<string>(Math.max(fill, 0)).fill("0"), ...last];
  if (all.length !== 8 || all.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) {
    return undefined;
  }
  return { value: all.reduce((sum, group) => sum * 65536n + BigInt(`0x${group}`), 0n), bits: 128 };
}

/** Whether the address is inside the network (`10.0.0.0/24`, `fd00::/64`). */
export function inNetwork(address: string, cidr: string): boolean {
  const [base = "", length = ""] = cidr.split("/");
  const a = numeric(address);
  const b = numeric(base);
  const prefix = Number(length);
  if (a === undefined || b === undefined || a.bits !== b.bits || !Number.isInteger(prefix) || prefix < 0 || prefix > a.bits) {
    return false;
  }
  const shift = BigInt(a.bits - prefix);
  return a.value >> shift === b.value >> shift;
}

/** Local to the container: loopback, the link-local scope of IPv6, and the networks of the stack. */
function isLocal(address: string, networks: readonly string[]): boolean {
  return ["127.0.0.0/8", "::1/128", "fe80::/10", "ff02::/16", ...networks].some((cidr) => inNetwork(address, cidr));
}

export interface Expectation {
  /** The networks of the compose project (`docker network inspect`). */
  networks: readonly string[];
  /** The names of the stack's own services. */
  names: readonly string[];
  /** The host of the saved bookmark. */
  bookmarkHost: string;
  /** When the bookmark was saved, in seconds since the epoch, read from the clock of the capture's host. */
  savedAt: number;
}

function normalized(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

/** Whether a name is the bookmark's host, or that host with a search domain of the resolver's configuration appended. */
function isBookmarkLookup(name: string, host: string): boolean {
  return name === host || name.startsWith(`${host}.`);
}

/** The records that are a lookup of the bookmark's host. */
export function lookupsOf(records: readonly CaptureRecord[], host: string): CaptureRecord[] {
  return records.filter((record) => record.question !== undefined && isBookmarkLookup(normalized(record.question.name), host));
}

/** Whether a record is a DNS question for exactly this name. */
export function asked(records: readonly CaptureRecord[], name: string): boolean {
  return records.some((record) => record.question !== undefined && normalized(record.question.name) === name);
}

/** How long after a process asked Docker's resolver a question the resolver may forward it to a name server. */
const FORWARD_WINDOW_SECONDS = 5;

/** Whether the record is a question that Docker's resolver forwarded: the same question was put to it, on the loopback address, just before. */
function isForwarded(record: CaptureRecord, records: readonly CaptureRecord[]): boolean {
  const { question } = record;
  return (
    question !== undefined &&
    records.some(
      (earlier) =>
        earlier.container === record.container &&
        earlier.question?.type === question.type &&
        earlier.question.name === question.name &&
        earlier.at <= record.at &&
        record.at - earlier.at <= FORWARD_WINDOW_SECONDS &&
        inNetwork(earlier.to, "127.0.0.0/8"),
    )
  );
}

/**
 * What the capture shows that a default instance does not do: a question for a name that is neither a service of the stack nor, once the
 * bookmark is saved, its host; a lookup of that host before the save; and any TCP connection attempt, datagram or ping to an address
 * that is not loopback and not in the compose networks. A question that goes to such an address is the one exception, when it is the
 * resolver forwarding a question a process put to it: with the route to the loopback device that the capture adds, Docker's attempt to
 * pass a lookup of the saved host to the host's name server leaves the container and is dropped at once, and is the lookup the name already
 * allows. A question that reaches an outside server any other way is reported. An empty list means the instance made none.
 */
export function problemsOf(records: readonly CaptureRecord[], expectation: Expectation): string[] {
  const problems = new Set<string>();
  for (const record of records) {
    const { question } = record;
    if (question !== undefined) {
      const name = normalized(question.name);
      if (isBookmarkLookup(name, expectation.bookmarkHost)) {
        if (record.at < expectation.savedAt) {
          problems.add(`${record.container} looked up ${name} (${question.type}) before the bookmark was saved`);
        }
      } else if (!expectation.names.includes(name)) {
        problems.add(`${record.container} asked for the name ${name} (${question.type})`);
      }
    }
    if (!isLocal(record.to, expectation.networks) && !isForwarded(record, records)) {
      const port = record.toPort === undefined ? "" : `:${String(record.toPort)}`;
      const what = { "dns-query": "a DNS question", tcp: "a TCP connection attempt", icmp: "an ICMP packet", datagram: "a datagram" }[record.protocol];
      problems.add(`${record.container} sent ${what} to ${record.to}${port}, outside the compose network`);
    }
  }
  return [...problems];
}

/** Whether the project's `internal` network is internal and what its address ranges are, from `docker network inspect`. */
export function networkOf(stack: DrillStack): { internal: boolean; subnets: string[] } {
  const result = spawnSync("docker", ["network", "inspect", `${stack.project}_internal`], { encoding: "utf8", timeout: 60_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("docker network inspect could not read the network of the stack");
  }
  const [network] = JSON.parse(result.stdout) as { Internal?: boolean; IPAM?: { Config?: { Subnet?: string }[] } }[];
  const subnets = (network?.IPAM?.Config ?? []).flatMap((config) => (config.Subnet === undefined ? [] : [config.Subnet]));
  return { internal: network?.Internal === true, subnets };
}

/** The log of a capture container: every packet it recorded since it started. */
export function readCapture(stack: DrillStack, container: string, capture: string): ParsedCapture {
  const file = join(stack.workDir, `${capture}.log`);
  compose(stack, ["logs", "--no-color", "--no-log-prefix", capture], { stdoutFile: file });
  return parseCapture(container, readFileSync(file, "utf8"));
}

/**
 * The time of the capture's host in whole seconds, read from inside the capture container, so that the moment of the save is on the clock
 * that stamps the records. It is rounded down, which can only let a lookup in the same second count as after the save.
 */
export function captureClock(stack: DrillStack): number {
  const { stdout } = compose(stack, ["exec", "-T", "capture-server", "date", "+%s"]);
  const seconds = Number(stdout.trim());
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("the clock of the capture container could not be read");
  }
  return seconds;
}

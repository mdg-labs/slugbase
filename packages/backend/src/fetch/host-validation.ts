import { isIP } from "node:net";

import { FetchBlockedError } from "./fetch.errors.js";

export type DnsLookupResult = {
  address: string;
  family: number;
};

export type DnsLookupFn = (
  hostname: string,
) => Promise<readonly DnsLookupResult[]>;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google",
  "metadata.google.internal",
  "instance-data",
]);

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).toLowerCase();
  }
  return trimmed;
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  if (BLOCKED_HOSTNAMES.has(normalized)) {
    return true;
  }

  if (normalized.endsWith(".localhost")) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion !== 0) {
    return isPrivateOrLoopbackAddress(normalized);
  }

  return false;
}

function parseIpv4Octets(address: string): [number, number, number, number] {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    throw new FetchBlockedError(`Invalid IPv4 address: ${address}`);
  }

  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

function isPrivateOrLoopbackIpv4(address: string): boolean {
  const [first, second] = parseIpv4Octets(address);

  if (first === 127) {
    return true;
  }

  if (first === 10) {
    return true;
  }

  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }

  if (first === 192 && second === 168) {
    return true;
  }

  if (first === 169 && second === 254) {
    return true;
  }

  if (first === 0) {
    return true;
  }

  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }

  if (first === 192 && second === 0) {
    return true;
  }

  if (first === 198 && (second === 18 || second === 19)) {
    return true;
  }

  if (first >= 224) {
    return true;
  }

  return false;
}

function expandIpv6(address: string): number[] {
  const lower = address.toLowerCase();
  const [head, tail] = lower.split("::");

  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;

  if (missing < 0) {
    throw new FetchBlockedError(`Invalid IPv6 address: ${address}`);
  }

  const expanded = [
    ...headParts.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...tailParts.map((part) => Number.parseInt(part, 16)),
  ];

  if (expanded.length !== 8 || expanded.some((part) => Number.isNaN(part))) {
    throw new FetchBlockedError(`Invalid IPv6 address: ${address}`);
  }

  return expanded;
}

function isPrivateOrLoopbackIpv6(address: string): boolean {
  const normalized = address.toLowerCase();

  if (normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("fe80:")) {
    return true;
  }

  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) {
      return isPrivateOrLoopbackIpv4(mapped);
    }
  }

  const parts = expandIpv6(normalized);
  const first = parts[0] ?? 0;

  if (first === 0xff1e) {
    return true;
  }

  return false;
}

export function isPrivateOrLoopbackAddress(address: string): boolean {
  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    return isPrivateOrLoopbackIpv4(address);
  }

  if (ipVersion === 6) {
    return isPrivateOrLoopbackIpv6(address);
  }

  throw new FetchBlockedError(`Invalid IP address: ${address}`);
}

export async function assertPublicHost(
  hostname: string,
  lookup: DnsLookupFn,
): Promise<void> {
  if (isBlockedHostname(hostname)) {
    throw new FetchBlockedError(`Blocked host: ${hostname}`);
  }

  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    if (isPrivateOrLoopbackAddress(hostname)) {
      throw new FetchBlockedError(`Blocked IP address: ${hostname}`);
    }
    return;
  }

  const records = await lookup(hostname);
  if (records.length === 0) {
    throw new FetchBlockedError(`Host could not be resolved: ${hostname}`);
  }

  for (const record of records) {
    if (isPrivateOrLoopbackAddress(record.address)) {
      throw new FetchBlockedError(
        `Resolved address is not public: ${record.address}`,
      );
    }
  }
}

export function parseAndValidateRequestUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new FetchBlockedError(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchBlockedError(`Unsupported protocol: ${parsed.protocol}`);
  }

  if (!parsed.hostname) {
    throw new FetchBlockedError("URL is missing a hostname");
  }

  return parsed;
}

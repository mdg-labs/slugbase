// Address parsing and classification for the egress adapter (T6). An address is
// parsed into its bytes first and classified by what it denotes, so the notation
// it arrived in (decimal, octal or hexadecimal IPv4, IPv4-mapped IPv6) cannot
// change the verdict. Anything that does not parse is not public.

export type AddressBytes = readonly number[];

export interface ParsedAddress {
  readonly family: 4 | 6;
  readonly bytes: AddressBytes;
}

const IPV4_PART = /^(?:0[xX][0-9a-fA-F]*|[0-9]+)$/;

function ipv4Part(part: string): number | undefined {
  if (!IPV4_PART.test(part)) {
    return undefined;
  }
  let value: number;
  if (/^0[xX]/.test(part)) {
    value = part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
  } else if (part.length > 1 && part.startsWith("0")) {
    if (/[89]/.test(part)) {
      return undefined;
    }
    value = Number.parseInt(part, 8);
  } else {
    value = Number.parseInt(part, 10);
  }
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Parses an IPv4 address in any notation the C library accepts (`inet_aton`): one
 * to four parts, each decimal, octal with a leading `0` or hexadecimal with `0x`,
 * the last part filling the remaining bytes.
 */
export function parseIPv4(text: string): AddressBytes | undefined {
  const parts = text.split(".");
  if (parts.length < 1 || parts.length > 4) {
    return undefined;
  }
  const values: number[] = [];
  for (const part of parts) {
    const value = ipv4Part(part);
    if (value === undefined) {
      return undefined;
    }
    values.push(value);
  }
  const last = values.pop() ?? 0;
  const bytes: number[] = [];
  for (const value of values) {
    if (value > 255) {
      return undefined;
    }
    bytes.push(value);
  }
  const remaining = 4 - bytes.length;
  if (last >= 256 ** remaining) {
    return undefined;
  }
  for (let index = remaining - 1; index >= 0; index -= 1) {
    bytes.push(Math.floor(last / 256 ** index) % 256);
  }
  return bytes;
}

function dottedQuad(text: string): AddressBytes | undefined {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part))) {
    return undefined;
  }
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : undefined;
}

function groups(text: string): number[] | undefined {
  if (text === "") {
    return [];
  }
  const result: number[] = [];
  const parts = text.split(":");
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1 && part.includes(".")) {
      const quad = dottedQuad(part);
      if (quad === undefined) {
        return undefined;
      }
      result.push(((quad[0] ?? 0) << 8) | (quad[1] ?? 0), ((quad[2] ?? 0) << 8) | (quad[3] ?? 0));
    } else if (/^[0-9a-fA-F]{1,4}$/.test(part)) {
      result.push(Number.parseInt(part, 16));
    } else {
      return undefined;
    }
  }
  return result;
}

/** Parses an IPv6 address (RFC 4291 text forms, an embedded dotted IPv4 tail included). A zone id is not accepted. */
export function parseIPv6(text: string): AddressBytes | undefined {
  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  let words: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) {
      return undefined;
    }
    words = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  } else {
    words = head;
  }
  if (words.length !== 8) {
    return undefined;
  }
  return words.flatMap((word) => [word >> 8, word & 255]);
}

/** Parses the host of a URL (an IPv6 literal without its brackets) or a resolver answer; undefined when it is not an IP address. */
export function parseAddress(text: string): ParsedAddress | undefined {
  if (text.includes(":")) {
    const bytes = parseIPv6(text);
    return bytes === undefined ? undefined : { family: 6, bytes };
  }
  const bytes = parseIPv4(text);
  return bytes === undefined ? undefined : { family: 4, bytes };
}

/** The canonical text of an address, as a socket takes it. */
export function formatAddress({ family, bytes }: ParsedAddress): string {
  if (family === 4) {
    return bytes.join(".");
  }
  const words: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    words.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  return words.join(":");
}

type Cidr4 = readonly [a: number, b: number, c: number, d: number, prefix: number];

// Every IPv4 range that is not publicly routable (IANA special-purpose registry, RFC 6890 and updates).
const NON_PUBLIC_V4: readonly Cidr4[] = [
  [0, 0, 0, 0, 8], // this network, unspecified
  [10, 0, 0, 0, 8], // private (RFC 1918)
  [100, 64, 0, 0, 10], // CGNAT (RFC 6598)
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local, the cloud metadata address
  [172, 16, 0, 0, 12], // private (RFC 1918)
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // documentation (TEST-NET-1)
  [192, 88, 99, 0, 24], // 6to4 relay anycast (deprecated)
  [192, 168, 0, 0, 16], // private (RFC 1918)
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // documentation (TEST-NET-2)
  [203, 0, 113, 0, 24], // documentation (TEST-NET-3)
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, limited broadcast
];

function inCidr4(bytes: AddressBytes, [a, b, c, d, prefix]: Cidr4): boolean {
  const address = (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
  const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

function isPublicV4(bytes: AddressBytes): boolean {
  return !NON_PUBLIC_V4.some((range) => inCidr4(bytes, range));
}

function startsWith(bytes: AddressBytes, prefix: readonly number[], bits: number): boolean {
  for (let index = 0; index < bits; index += 1) {
    const byte = Math.floor(index / 8);
    const mask = 0x80 >> index % 8;
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) {
      return false;
    }
  }
  return true;
}

// Ranges inside the global unicast block 2000::/3 that are still not public.
const NON_PUBLIC_V6: readonly (readonly [prefix: readonly number[], bits: number])[] = [
  [[0x20, 0x01, 0x00, 0x00], 32], // Teredo
  [[0x20, 0x01, 0x00, 0x02, 0x00, 0x00], 48], // benchmarking
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x20, 0x01, 0x00, 0x10], 28], // ORCHID and ORCHIDv2
  [[0x3f, 0xff], 20], // documentation (RFC 9637)
];

function isPublicV6(bytes: AddressBytes): boolean {
  if (startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) {
    return isPublicV4(bytes.slice(12));
  }
  // Only the global unicast block 2000::/3 is public: loopback, unspecified, unique-local, link-local,
  // multicast, NAT64 and every other reserved block lie outside it.
  if (!startsWith(bytes, [0x20], 3)) {
    return false;
  }
  if (startsWith(bytes, [0x20, 0x02], 16)) {
    return isPublicV4(bytes.slice(2, 6));
  }
  return !NON_PUBLIC_V6.some(([prefix, bits]) => startsWith(bytes, prefix, bits));
}

/** Whether the address is a public one the server may connect to. */
export function isPublicAddress({ family, bytes }: ParsedAddress): boolean {
  return family === 4 ? isPublicV4(bytes) : isPublicV6(bytes);
}

/** Classifies the text of an address; text that is not an address is not public. */
export function isPublicAddressText(text: string): boolean {
  const parsed = parseAddress(text);
  return parsed !== undefined && isPublicAddress(parsed);
}

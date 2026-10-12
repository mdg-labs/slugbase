import { createSocket } from "node:dgram";
import { isIPv4, isIPv6 } from "node:net";

// A DNS server over UDP on loopback, for the tests of the egress adapter. It answers A and AAAA
// questions from a script, so a name can answer differently the second time it is asked, and it
// records every question. Nothing leaves the machine.

export type RecordType = "A" | "AAAA";

/** The addresses a name answers with. `ordinal` counts the questions of that type for that name, from 1. */
export type Answer = (type: RecordType, ordinal: number) => readonly string[];

export interface DnsStub {
  /** The server, as the `address:port` the adapter's `dnsServers` option takes. */
  readonly server: string;
  /** Every question received, in order. */
  readonly questions: { readonly name: string; readonly type: RecordType }[];
  /** Answers `name` with `addresses` for every question of the matching family and an empty answer for the other. */
  set(name: string, answer: readonly string[] | Answer): void;
  close(): Promise<void>;
}

const TYPE_CODE: Readonly<Record<RecordType, number>> = { A: 1, AAAA: 28 };
const HEADER_BYTES = 12;

function ipv4Bytes(text: string): Buffer {
  return Buffer.from(text.split(".").map(Number));
}

function ipv6Bytes(text: string): Buffer {
  let source = text;
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(source)?.[1];
  if (embedded !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = embedded.split(".").map(Number);
    source = `${source.slice(0, -embedded.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = source.split("::");
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const zeros = tail === undefined ? [] : Array<string>(8 - front.length - back.length).fill("0");
  const bytes = Buffer.alloc(16);
  [...front, ...zeros, ...back].forEach((group, index) => {
    bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2);
  });
  return bytes;
}

function question(message: Buffer): { name: string; type: number; end: number } | undefined {
  const labels: string[] = [];
  let offset = HEADER_BYTES;
  for (;;) {
    const length = message[offset];
    if (length === undefined) {
      return undefined;
    }
    if (length === 0) {
      break;
    }
    labels.push(message.subarray(offset + 1, offset + 1 + length).toString("latin1"));
    offset += length + 1;
  }
  const end = offset + 1 + 4;
  return message.length < end ? undefined : { name: labels.join(".").toLowerCase(), type: message.readUInt16BE(offset + 1), end };
}

export async function startDnsStub(): Promise<DnsStub> {
  const answers = new Map<string, Answer>();
  const asked = new Map<string, number>();
  const questions: DnsStub["questions"] = [];
  const socket = createSocket("udp4");

  socket.on("message", (message, remote) => {
    const asking = question(message);
    if (asking === undefined) {
      return;
    }
    const type = asking.type === TYPE_CODE.A ? "A" : asking.type === TYPE_CODE.AAAA ? "AAAA" : undefined;
    const answer = answers.get(asking.name);
    let addresses: readonly string[] = [];
    if (type !== undefined) {
      questions.push({ name: asking.name, type });
      const key = `${type} ${asking.name}`;
      const ordinal = (asked.get(key) ?? 0) + 1;
      asked.set(key, ordinal);
      addresses = answer?.(type, ordinal) ?? [];
    }
    const records = addresses.map((address) => {
      const data = type === "A" ? ipv4Bytes(address) : ipv6Bytes(address);
      const head = Buffer.alloc(12);
      head.writeUInt16BE(0xc00c, 0);
      head.writeUInt16BE(asking.type, 2);
      head.writeUInt16BE(1, 4);
      head.writeUInt32BE(0, 6);
      head.writeUInt16BE(data.length, 10);
      return Buffer.concat([head, data]);
    });
    const header = Buffer.alloc(HEADER_BYTES);
    message.copy(header, 0, 0, 2);
    // Response, recursion available; NXDOMAIN for a name nobody set, success (maybe empty) otherwise.
    header.writeUInt16BE(0x8180 | (answer === undefined ? 3 : 0), 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(records.length, 6);
    socket.send(Buffer.concat([header, message.subarray(HEADER_BYTES, asking.end), ...records]), remote.port, remote.address);
  });

  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    server: `127.0.0.1:${String(socket.address().port)}`,
    questions,
    set(name, answer) {
      answers.set(
        name.toLowerCase(),
        typeof answer === "function"
          ? answer
          : (type) => answer.filter((address) => (type === "A" ? isIPv4(address) : isIPv6(address))),
      );
    },
    close: () =>
      new Promise<void>((resolve) => {
        socket.close(() => {
          resolve();
        });
      }),
  };
}

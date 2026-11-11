import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asked, inNetwork, lookupsOf, parseCapture, problemsOf, type CaptureRecord, type Expectation } from "./no-egress.ts";

// The lines are what `tcpdump -n -tt -T domain` printed in the capture containers of e2e/compose.no-egress.yml.

const SAVED_AT = 1_794_330_000;
const EXPECTATION: Expectation = {
  networks: ["10.210.27.0/24"],
  names: ["postgres"],
  bookmarkHost: "bookmark.example.test",
  savedAt: SAVED_AT,
};

const BANNER = [
  "tcpdump: verbose output suppressed, use -v[v]... for full protocol decode",
  "listening on any, link-type LINUX_SLL2 (Linux cooked v2), snapshot length 262144 bytes",
];

/** The records of a capture made of these lines, with the banner tcpdump writes first. */
function records(...lines: string[]): CaptureRecord[] {
  const parsed = parseCapture("slugbase", [...BANNER, ...lines].join("\n"));
  assert.deepEqual(parsed.unreadable, []);
  return parsed.records;
}

/** The record at an index of a list of the records a test read. */
function at(list: readonly CaptureRecord[], index: number): CaptureRecord {
  const found = list[index];
  assert.ok(found !== undefined, `a record at ${String(index)}`);
  return found;
}

const question = (at: number, name: string, type = "A"): string => `${String(at)}.100000 lo    In  IP 127.0.0.1.35241 > 127.0.0.11.60808: 44408+ ${type}? ${name} (39)`;
const response = (at: number): string => `${String(at)}.200000 lo    In  IP 127.0.0.11.53 > 127.0.0.1.35241: 44408 NXDomain 0/1/0 (114)`;
const syn = (at: number, from: string, to: string): string =>
  `${String(at)}.300000 eth0  Out IP ${from} > ${to}: Flags [S], seq 895055152, win 64240, options [mss 1460,sackOK,TS val 136476881 ecr 0,nop,wscale 10], length 0`;

/** What a default instance does while it runs: it looks up the database, connects to it and answers the relay. */
const BOOT = [
  question(SAVED_AT - 100, "postgres."),
  question(SAVED_AT - 100, "postgres.", "AAAA"),
  response(SAVED_AT - 100),
  syn(SAVED_AT - 100, "10.210.27.2.41431", "10.210.27.3.5432"),
  syn(SAVED_AT - 90, "10.210.27.4.52572", "10.210.27.2.3000"),
  syn(SAVED_AT - 90, "127.0.0.1.52572", "127.0.0.1.3000"),
];

void describe("the reading of a capture", () => {
  void it("reads questions, connection attempts and answers, and skips what tcpdump says about itself", () => {
    const read = records(question(5, "bookmark.example.test.", "AAAA"), response(5), syn(6, "10.210.27.2.59312", "192.0.2.1.80"), `${String(7)}.1 eth0  Out IP 10.210.27.2 > 203.0.113.9: ICMP echo request, id 14623, seq 1, length 64`);
    assert.equal(at(read, 0).protocol, "dns-query");
    assert.deepEqual(at(read, 0).question, { type: "AAAA", name: "bookmark.example.test." });
    assert.equal(at(read, 1).protocol, "datagram");
    assert.deepEqual([at(read, 2).protocol, at(read, 2).to, at(read, 2).toPort], ["tcp", "192.0.2.1", 80]);
    assert.deepEqual([at(read, 3).protocol, at(read, 3).to, at(read, 3).toPort], ["icmp", "203.0.113.9", undefined]);
  });

  void it("reads a question that carries EDNS and an address of IPv6", () => {
    const read = records(
      "10.1 eth0  Out IP 10.210.27.2.37227 > 10.255.255.254.53: 63299+ [1au] HTTPS? example.org. (51)",
      "11.1 eth0  Out IP6 fd00::2.4000 > 2001:db8::1.443: Flags [S], seq 1, win 64240, length 0",
    );
    assert.deepEqual(at(read, 0).question, { type: "HTTPS", name: "example.org." });
    assert.deepEqual([at(read, 1).from, at(read, 1).to, at(read, 1).toPort], ["fd00::2", "2001:db8::1", 443]);
  });

  void it("cuts the control sequence that docker compose logs writes before a line", () => {
    const escape = String.fromCharCode(27);
    const read = records(`${escape}[2K${question(5, "postgres.")}`);
    assert.equal(at(read, 0).question?.name, "postgres.");
  });

  void it("reports a line it cannot read instead of skipping it", () => {
    const parsed = parseCapture("slugbase", [...BANNER, "something went wrong in the capture", question(5, "postgres.")].join("\n"));
    assert.deepEqual(parsed.unreadable, ["something went wrong in the capture"]);
    assert.equal(parsed.records.length, 1);
  });
});

void describe("the networks of the stack", () => {
  void it("tells an address inside a network from one outside it, in both families", () => {
    assert.equal(inNetwork("10.210.27.9", "10.210.27.0/24"), true);
    assert.equal(inNetwork("10.210.28.9", "10.210.27.0/24"), false);
    assert.equal(inNetwork("fd00::2", "fd00::/64"), true);
    assert.equal(inNetwork("fd01::2", "fd00::/64"), false);
    assert.equal(inNetwork("10.210.27.9", "fd00::/64"), false);
  });
});

void describe("the predicate over the records of a default instance", () => {
  void it("accepts the expected records: the database, the compose network, loopback, and the bookmark's host after the save", () => {
    const expected = records(
      ...BOOT,
      question(SAVED_AT + 1, "bookmark.example.test."),
      question(SAVED_AT + 1, "bookmark.example.test.", "AAAA"),
      question(SAVED_AT + 2, "Bookmark.Example.Test.search.example."),
      response(SAVED_AT + 2),
    );
    assert.deepEqual(problemsOf(expected, EXPECTATION), []);
    assert.equal(lookupsOf(expected, EXPECTATION.bookmarkHost).length, 3);
    assert.equal(asked(expected, "postgres"), true);
  });

  void it("reports a question for another name", () => {
    assert.deepEqual(problemsOf(records(...BOOT, question(SAVED_AT + 5, "telemetry.example.org.")), EXPECTATION), ["slugbase asked for the name telemetry.example.org (A)"]);
  });

  void it("reports a question for a name that only contains the bookmark's host", () => {
    assert.equal(problemsOf(records(question(SAVED_AT + 5, "notbookmark.example.test.")), EXPECTATION).length, 1);
    assert.equal(problemsOf(records(question(SAVED_AT + 5, "bookmark.example.test.evil.example.")), EXPECTATION).length, 0, "a search domain is appended after the host");
  });

  void it("reports a connection attempt to an address outside the compose network", () => {
    assert.deepEqual(problemsOf(records(...BOOT, syn(SAVED_AT + 5, "10.210.27.2.49018", "192.0.2.1.80")), EXPECTATION), [
      "slugbase sent a TCP connection attempt to 192.0.2.1:80, outside the compose network",
    ]);
  });

  void it("reports a datagram, a ping and an IPv6 connection attempt to an address outside it", () => {
    const problems = problemsOf(
      records(
        `${String(SAVED_AT + 5)}.1 eth0  Out IP 10.210.27.2.52572 > 198.51.100.7.123: domain [length 1 < 12] (invalid)`,
        `${String(SAVED_AT + 6)}.1 eth0  Out IP 10.210.27.2 > 203.0.113.9: ICMP echo request, id 14623, seq 1, length 64`,
        `${String(SAVED_AT + 7)}.1 eth0  Out IP6 fd00::2.4000 > 2001:db8::1.443: Flags [S], seq 1, win 64240, length 0`,
      ),
      EXPECTATION,
    );
    assert.deepEqual(problems, [
      "slugbase sent a datagram to 198.51.100.7:123, outside the compose network",
      "slugbase sent an ICMP packet to 203.0.113.9, outside the compose network",
      "slugbase sent a TCP connection attempt to 2001:db8::1:443, outside the compose network",
    ]);
  });

  void it("accepts the question that Docker's resolver forwards for a lookup it was asked, and reports one that goes out on its own", () => {
    const forwarded = (at: number, name: string): string => `${String(at)}.400000 eth0  Out IP 10.210.27.2.37227 > 10.255.255.254.53: 63299+ A? ${name} (39)`;
    assert.deepEqual(problemsOf(records(question(SAVED_AT + 1, "bookmark.example.test."), forwarded(SAVED_AT + 1, "bookmark.example.test.")), EXPECTATION), []);
    assert.deepEqual(problemsOf(records(forwarded(SAVED_AT + 1, "bookmark.example.test.")), EXPECTATION), [
      "slugbase sent a DNS question to 10.255.255.254:53, outside the compose network",
    ]);
    assert.deepEqual(problemsOf(records(question(SAVED_AT + 1, "bookmark.example.test."), forwarded(SAVED_AT + 30, "bookmark.example.test.")), EXPECTATION), [
      "slugbase sent a DNS question to 10.255.255.254:53, outside the compose network",
    ]);
  });

  void it("reports the forwarded question of a name that the instance may not ask for", () => {
    const lines = [question(SAVED_AT + 1, "example.org."), `${String(SAVED_AT + 1)}.400000 eth0  Out IP 10.210.27.2.37227 > 10.255.255.254.53: 63299+ A? example.org. (39)`];
    assert.deepEqual(problemsOf(records(...lines), EXPECTATION), ["slugbase asked for the name example.org (A)"]);
  });

  void it("reports a lookup of the bookmark's host before the save", () => {
    assert.deepEqual(problemsOf(records(...BOOT, question(SAVED_AT - 20, "bookmark.example.test.")), EXPECTATION), [
      "slugbase looked up bookmark.example.test (A) before the bookmark was saved",
    ]);
  });

  void it("finds no lookup of the bookmark's host in a capture that holds none, which the drill requires", () => {
    assert.equal(lookupsOf(records(...BOOT), EXPECTATION.bookmarkHost).length, 0);
    assert.equal(lookupsOf(records(), EXPECTATION.bookmarkHost).length, 0);
  });
});

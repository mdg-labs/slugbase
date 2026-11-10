import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  asked,
  BOOKMARK_HOST,
  CAPTURED,
  captureClock,
  COMPOSE_NAMES,
  lookupsOf,
  networkOf,
  NO_EGRESS_COMPOSE,
  problemsOf,
  readCapture,
  type CaptureRecord,
} from "./support/no-egress.ts";
import { compose, startDrillStack, STACK_START_MS, type DrillStack, type Session } from "./support/restore-drill.ts";
import { newSession, record, signIn, text } from "./support/seed-instance.ts";

// The no-egress drill (doc 08 section 5.1, Q18, doc 10 T6): it proves on the image of this commit that an instance with no optional adapter
// configured looks up no name and opens no connection outside its compose network, except the lookups of the host of a URL a member saved.
// The stack is the drill's own (e2e/restore-drill-stack.sh) with e2e/compose.no-egress.yml merged over compose.yml and nothing of
// compose.e2e.yml: the database, the server and the worker are on a network with no route out, and a capture in the network namespace of the
// server and of the worker records every DNS question, every datagram and every connection attempt from their first packet.
//
// The drill claims the instance through setup over the HTTP API, signs in and idles; saves one bookmark whose host is a reserved name
// (https://bookmark.example.test/), which queues the worker's fetch of its metadata (the fetch of its icon waits until the app asks for the icon, which this drill never does); and idles with the worker running. It then reads
// the records of both containers: none may be a question for a name that is not a service of the stack, a lookup of the bookmark's host
// before the save, or a packet to an address outside the compose network, and the lookup of the host after the save must be there, so that an
// empty capture cannot pass. The scheduled jobs are not waited for: each is maintenance with no egress, and the idle covers the start-up work.
//
// A control closes the drill: a process started in each container asks for another name and connects to an address outside the network, and
// the same reading of the capture must report both for both containers, so that a capture that stops seeing cannot pass either.
// The image of the commit is SLUGBASE_IMAGE (or E2E_IMAGE); its secrets are made up for the run and are never printed.

/** The wait after sign-in and before the save, in which the instance is idle with nothing saved. */
const IDLE_BEFORE_SAVE_MS = 30_000;
/** The wait after the save, with the worker running: at least the 120 seconds the criterion names. */
const IDLE_AFTER_SAVE_MS = 120_000;
/** The time the capture needs to flush what a process of the control sent. */
const CONTROL_SETTLE_MS = 3_000;
const CONTROL_NAME = "control.example.net";
const CONTROL_ADDRESS = "192.0.2.1";
const CONTROL_PROBE = `require('node:dns').lookup('${CONTROL_NAME}', () => {}); require('node:net').connect({ host: '${CONTROL_ADDRESS}', port: 80 }).on('error', () => {}); setTimeout(() => process.exit(0), 2000);`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What the captures hold now, with every line readable. */
function recorded(stack: DrillStack): CaptureRecord[] {
  return CAPTURED.flatMap(({ service, capture }) => {
    const parsed = readCapture(stack, service, capture);
    expect(parsed.unreadable, `the lines of the capture of ${service} that are not packets`).toEqual([]);
    return parsed.records;
  });
}

test("a default instance contacts nothing outside its compose network but the host of a saved URL", async () => {
  test.setTimeout(STACK_START_MS + 15 * 60_000);
  const stack = await startDrillStack({ ...process.env, SMOKE_EXTRA_COMPOSE_FILES: NO_EGRESS_COMPOSE });
  let passed = false;
  try {
    const network = networkOf(stack);
    await test.step("the stack is on a network with no route out", () => {
      expect(network.internal, "the network of the stack is internal").toBe(true);
      expect(network.subnets.length, "the address ranges of the network").toBeGreaterThan(0);
    });

    const token = randomBytes(4).toString("hex");
    const owner = { email: `owner-${token}@example.test`, password: randomBytes(24).toString("base64url") };
    let session: Session | undefined;
    await test.step("the instance is claimed through setup, the owner signs in, and it idles", async () => {
      await newSession(stack).expect("POST", "/api/v1/setup", 201, {
        displayName: "No Egress Owner",
        email: owner.email,
        password: owner.password,
        workspaceName: "No egress",
        setupToken: stack.setupToken,
      });
      session = await signIn(stack, owner);
      expect(record(await session.read("/api/v1/me"), "the account").account, "the account that signed in").toBeDefined();
      await sleep(IDLE_BEFORE_SAVE_MS);
    });

    let savedAt = 0;
    await test.step("one bookmark with a reserved host is saved, and the instance idles with the worker running", async () => {
      if (session === undefined) {
        throw new Error("the owner did not sign in");
      }
      savedAt = captureClock(stack);
      const created = record(await session.expect("POST", "/api/v1/bookmarks", 201, { url: `https://${BOOKMARK_HOST}/`, title: "A bookmark of no egress" }), "a bookmark");
      text(created.id, "a bookmark id");
      await sleep(IDLE_AFTER_SAVE_MS);
    });

    const expectation = { networks: network.subnets, names: COMPOSE_NAMES, bookmarkHost: BOOKMARK_HOST, savedAt };
    await test.step("the records show no question, datagram or connection attempt that a default instance does not make", () => {
      const records = recorded(stack);
      for (const { service } of CAPTURED) {
        const own = records.filter((entry) => entry.container === service);
        expect(own.length, `the records of ${service}`).toBeGreaterThan(0);
        expect(asked(own, "postgres"), `${service} asked for the database by its name`).toBe(true);
      }
      expect(
        lookupsOf(records, BOOKMARK_HOST).filter((entry) => entry.at >= savedAt).length,
        `the lookups of ${BOOKMARK_HOST} after the save`,
      ).toBeGreaterThan(0);
      expect(problemsOf(records, expectation), "what the instance contacted that it should not").toEqual([]);
    });

    await test.step("the control: a question and a connection attempt from each container are reported", async () => {
      for (const { service } of CAPTURED) {
        compose(stack, ["exec", "-T", service, "node", "-e", CONTROL_PROBE]);
      }
      await sleep(CONTROL_SETTLE_MS);
      const problems = problemsOf(recorded(stack), expectation);
      for (const { service } of CAPTURED) {
        expect(problems, `the control of ${service}`).toEqual(
          expect.arrayContaining([
            expect.stringContaining(`${service} asked for the name ${CONTROL_NAME}`),
            expect.stringContaining(`${service} sent a TCP connection attempt to ${CONTROL_ADDRESS}:80`),
          ]),
        );
      }
    });
    passed = true;
  } finally {
    await stack.finish(passed);
  }
});

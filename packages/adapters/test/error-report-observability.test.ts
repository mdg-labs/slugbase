import { SpanKind, SpanStatusCode, context, trace, type Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { createSentryErrorReport } from "../src/errors/index.ts";
import { startHttpSink, type HttpSink } from "./http-sink.ts";

// Tags, sampled traces and scheduled-job check-ins of the Sentry-protocol adapter. Each is off unless it is
// configured. A transaction passes the scrubber as an error does (T7), so the tests seed a transaction with
// the values doc 10 section 4 lists and read what the sink received.

const SEEDS = {
  email: "alice.seed@example.com",
  bearerValue: "seedtokenAAAA1111bbbb2222",
  cookieValue: "seedcookieCCCC3333dddd",
  password: "hunter2-seed-password",
  clientIp: "203.0.113.77",
  query: "seed-query-secret",
  dbPassword: "seed-db-password",
};

interface EnvelopeItem {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface ParsedEnvelope {
  readonly header: Record<string, unknown>;
  readonly items: readonly EnvelopeItem[];
}

function parseEnvelope(body: string): ParsedEnvelope {
  const lines = body.split("\n").filter((line) => line !== "");
  const [header, ...rest] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const items: EnvelopeItem[] = [];
  for (let at = 0; at + 1 < rest.length; at += 2) {
    items.push({ type: String(rest[at]?.["type"]), payload: rest[at + 1] ?? {} });
  }
  return { header: header ?? {}, items };
}

function itemsOf(sink: HttpSink, type: string): Record<string, unknown>[] {
  return sink.bodies.flatMap((body) => parseEnvelope(body).items.filter((item) => item.type === type).map((item) => item.payload));
}

const sinks: HttpSink[] = [];

async function startSink(): Promise<HttpSink> {
  const sink = await startHttpSink();
  sinks.push(sink);
  return sink;
}

afterEach(async () => {
  trace.disable();
  await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function quiet(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function requestTracer(): Tracer {
  return trace.getTracer("@slugbase/server");
}

describe("tags", () => {
  it("puts the configured tags on every event, beside the request ID", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn, tags: { process: "worker", region: "eu-1" } });

    await errors.capture(new Error("first"), { requestId: "req-aaaa1111" });
    await errors.capture(new Error("second"));

    const events = itemsOf(sink, "event");
    expect(events).toHaveLength(2);
    expect(events[0]?.["tags"]).toEqual({ process: "worker", region: "eu-1", request_id: "req-aaaa1111" });
    expect(events[1]?.["tags"]).toEqual({ process: "worker", region: "eu-1" });
  });

  it("sends no tags when none are configured", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });

    await errors.capture(new Error("plain"));

    expect(itemsOf(sink, "event")[0]?.["tags"]).toBeUndefined();
  });

  it.each([
    ["a name that the scrubber would filter", { token: "x" }],
    ["a name with a space", { "a b": "x" }],
    ["the request ID name", { request_id: "x" }],
    ["an empty value", { process: "" }],
    ["a value with an e-mail address in it", { owner: SEEDS.email }],
    ["a value with a line break", { process: "a\nb" }],
    ["a value that is too long", { process: "x".repeat(201) }],
  ])("refuses %s", (_name, tags) => {
    expect(() => createSentryErrorReport({ dsn: "https://k@errors.example.com/1", tags })).toThrow(/tag/i);
  });
});

describe("sampled traces", () => {
  it("registers no tracer provider and sends no transaction when no rate is set", async () => {
    const sink = await startSink();
    createSentryErrorReport({ dsn: sink.dsn });

    const span = requestTracer().startSpan("GET /api/v1/bookmarks");
    expect(span.isRecording()).toBe(false);
    span.end();
    await quiet();

    expect(sink.bodies).toHaveLength(0);
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])("refuses the rate %s", (rate) => {
    expect(() => createSentryErrorReport({ dsn: "https://k@errors.example.com/1", tracesSampleRate: rate })).toThrow(/tracesSampleRate/);
  });

  it("sends a request span as a transaction, with nothing from the seeded request in the envelope", async () => {
    const sink = await startSink();
    createSentryErrorReport({ dsn: sink.dsn, environment: "test", release: "1.2.3", tracesSampleRate: 1, tags: { process: "server" } });

    const span = requestTracer().startSpan(`POST /api/v1/members/${SEEDS.email}/${SEEDS.bearerValue}?token=${SEEDS.query}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": "POST",
        "http.route": "/api/v1/widgets/{id}",
        "http.response.status_code": 500,
        "slugbase.request_id": "req-bbbb2222",
        "http.request.header.cookie": `sb_session=${SEEDS.cookieValue}`,
        "http.request.header.authorization": `Bearer ${SEEDS.bearerValue}`,
        "http.url": `https://bookmarks.example.com/api/v1/members/${SEEDS.email}?token=${SEEDS.query}`,
        "http.target": `/search?q=${SEEDS.query}`,
        "enduser.id": SEEDS.email,
        "client.address": SEEDS.clientIp,
        "db.statement": `INSERT INTO accounts (password) VALUES ('${SEEDS.password}')`,
        "db.connection_string": `postgres://slugbase_app:${SEEDS.dbPassword}@db.internal:5432/slugbase`,
        password: SEEDS.password,
      },
    });
    span.addEvent("exception", { "exception.message": `failed for ${SEEDS.email} with Bearer ${SEEDS.bearerValue}` });
    span.setStatus({ code: SpanStatusCode.ERROR, message: `failed for ${SEEDS.email}` });
    span.end();
    await until(() => sink.bodies.length > 0, "the transaction");
    await quiet();

    expect(sink.bodies).toHaveLength(1);
    const envelope = sink.bodies[0] ?? "";
    for (const [name, seed] of Object.entries(SEEDS)) {
      expect(envelope, name).not.toContain(seed);
    }
    expect(envelope).not.toContain("sb_session");
    expect(envelope).not.toContain("authorization");
    expect(envelope).not.toContain("Cookie");
    const [transaction, ...others] = itemsOf(sink, "transaction");
    expect(others).toHaveLength(0);
    expect(transaction).toMatchObject({
      type: "transaction",
      transaction: "POST /api/v1/members/{param}/{param}",
      environment: "test",
      release: "1.2.3",
      tags: { process: "server" },
    });
    expect(transaction?.["contexts"]).toMatchObject({ trace: { op: "http.server", status: "internal_error" } });
    expect(parseEnvelope(envelope).header["trace"]).toMatchObject({
      trace_id: (transaction?.["contexts"] as { trace: { trace_id: string } }).trace.trace_id,
      release: "1.2.3",
      environment: "test",
      sample_rate: "1",
    });
    expect(transaction?.["request"]).toBeUndefined();
    expect(transaction?.["user"]).toBeUndefined();
    expect(JSON.stringify(transaction?.["contexts"])).toContain("/api/v1/widgets/{id}");
  });

  it("scrubs a kept field that holds personal data", async () => {
    const sink = await startSink();
    createSentryErrorReport({ dsn: sink.dsn, tracesSampleRate: 1 });

    requestTracer()
      .startSpan("GET /api/v1/widgets/{id}", {
        kind: SpanKind.SERVER,
        attributes: { "http.route": `/api/v1/${SEEDS.email}`, "slugbase.request_id": SEEDS.email },
      })
      .end();
    await until(() => sink.bodies.length > 0, "the transaction");

    expect(sink.bodies[0] ?? "").not.toContain(SEEDS.email);
  });

  it("sends no transaction at rate 0, and none for a span that has a parent", async () => {
    const sink = await startSink();
    createSentryErrorReport({ dsn: sink.dsn, tracesSampleRate: 0 });
    const unsampled = requestTracer().startSpan("GET /api/v1/widgets/{id}", { kind: SpanKind.SERVER });
    expect(unsampled.isRecording()).toBe(false);
    unsampled.end();
    await quiet();
    expect(sink.bodies).toHaveLength(0);
    trace.disable();

    const traced = await startSink();
    createSentryErrorReport({ dsn: traced.dsn, tracesSampleRate: 1 });
    const parent = requestTracer().startSpan("GET /api/v1/widgets/{id}", { kind: SpanKind.SERVER });
    const child = requestTracer().startSpan(
      `SELECT ${SEEDS.password}`,
      { attributes: { "db.statement": `SELECT '${SEEDS.password}'` } },
      trace.setSpan(context.active(), parent),
    );
    child.end();
    parent.end();
    await until(() => traced.bodies.length > 0, "the transaction");
    await quiet();

    expect(traced.bodies).toHaveLength(1);
    expect(traced.bodies[0] ?? "").not.toContain(SEEDS.password);
    expect(itemsOf(traced, "transaction")).toHaveLength(1);
  });

  it("sends no transaction for a root span that another tracer opens, or that is not a server span", async () => {
    const sink = await startSink();
    createSentryErrorReport({ dsn: sink.dsn, tracesSampleRate: 1, tags: { process: "server" } });

    // What pg-boss does for a job in `server --with-worker`: root spans from its own scope.
    trace.getTracer("pg-boss").startSpan("process jobs", { kind: SpanKind.CONSUMER }).end();
    trace.getTracer("pg-boss").startSpan("send jobs", { kind: SpanKind.SERVER }).end();
    requestTracer().startSpan("GET /api/v1/widgets/{id}", { kind: SpanKind.INTERNAL }).end();
    await quiet();
    expect(sink.bodies).toHaveLength(0);

    requestTracer().startSpan("GET /api/v1/widgets/{id}", { kind: SpanKind.SERVER }).end();
    await until(() => sink.bodies.length > 0, "the request's transaction");
    await quiet();
    expect(itemsOf(sink, "transaction")).toHaveLength(1);
  });

  it("samples at the configured rate", async () => {
    const sink = await startSink();
    createSentryErrorReport({ dsn: sink.dsn, tracesSampleRate: 0.5 });

    // The SDK's transport queues at most 64 envelopes at once, so the spans go in batches that it can take.
    let recorded = 0;
    for (let batch = 0; batch < 10; batch += 1) {
      for (let count = 0; count < 20; count += 1) {
        const span = requestTracer().startSpan("GET /api/v1/widgets/{id}", { kind: SpanKind.SERVER });
        recorded += span.isRecording() ? 1 : 0;
        span.end();
      }
      await until(() => itemsOf(sink, "transaction").length >= recorded, "the batch's transactions");
    }
    expect(recorded).toBeGreaterThan(40);
    expect(recorded).toBeLessThan(160);
    await quiet();

    expect(itemsOf(sink, "transaction")).toHaveLength(recorded);
  });

  it("refuses a second adapter that wants the one tracer provider", () => {
    createSentryErrorReport({ dsn: "https://k@errors.example.com/1", tracesSampleRate: 1 });
    expect(() => createSentryErrorReport({ dsn: "https://k@errors.example.com/2", tracesSampleRate: 1 })).toThrow(/tracer provider/);
  });
});

describe("scheduled-job check-ins", () => {
  it("sends in_progress and then ok, with the duration and the environment", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn, environment: "production", release: "1.2.3", checkIns: true });

    const run = await errors.startMonitoredRun?.("rate-limit-purge-idle");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await run?.finish("ok");

    const checkIns = itemsOf(sink, "check_in");
    expect(checkIns).toHaveLength(2);
    expect(checkIns[0]).toMatchObject({ monitor_slug: "rate-limit-purge-idle", status: "in_progress", environment: "production", release: "1.2.3" });
    expect(checkIns[1]).toMatchObject({ monitor_slug: "rate-limit-purge-idle", status: "ok", environment: "production" });
    expect(checkIns[1]?.["check_in_id"]).toBe(checkIns[0]?.["check_in_id"]);
    expect(checkIns[1]?.["duration"]).toBeGreaterThan(0);
    expect(checkIns[0]?.["duration"]).toBeUndefined();
    for (const body of sink.bodies) {
      expect(body).not.toContain("seedpublickey");
    }
  });

  it("sends error for a failed run", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn, environment: "production", checkIns: true });

    const run = await errors.startMonitoredRun?.("retention-purge");
    await run?.finish("error");

    expect(itemsOf(sink, "check_in").map((checkIn) => checkIn["status"])).toEqual(["in_progress", "error"]);
  });

  it("offers no monitored run unless check-ins are on", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });

    expect("startMonitoredRun" in errors).toBe(false);
    await quiet();
    expect(sink.bodies).toHaveLength(0);
  });
});

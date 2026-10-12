import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createSentryErrorReport } from "../src/errors/index.ts";
import { startHttpSink, type HttpSink } from "./http-sink.ts";
import { routeTemplate, scrubEvent, scrubText } from "../src/errors/scrub.ts";

// T7: no secret, password, token, cookie or email reaches an error report. The
// adapter is exercised against a local HTTP sink that records every envelope
// it is sent.

const SEEDS = {
  email: "alice.seed@example.com",
  bearer: "Bearer seedtokenAAAA1111bbbb2222",
  bearerValue: "seedtokenAAAA1111bbbb2222",
  password: "hunter2-seed-password",
  cookie: "sb_session=seedcookieCCCC3333dddd",
  cookieValue: "seedcookieCCCC3333dddd",
  apiToken: "seed-api-token-EEEE5555",
  resetCode: "seed-reset-code-998877",
  clientIp: "203.0.113.77",
  connection: "postgres://slugbase_app:seed-db-password@db.internal:5432/slugbase",
  dbPassword: "seed-db-password",
  query: "q=seed-query-secret",
};

const sinks: HttpSink[] = [];

async function startSink(): Promise<HttpSink> {
  const sink = await startHttpSink();
  sinks.push(sink);
  return sink;
}

afterEach(async () => {
  await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

function failureWithSeeds(): Error {
  const body = JSON.stringify({ email: SEEDS.email, password: SEEDS.password, note: "kept" });
  return new Error(
    [
      `handler failed for ${SEEDS.email} from ${SEEDS.clientIp}`,
      `Authorization: ${SEEDS.bearer}`,
      `Cookie: ${SEEDS.cookie}`,
      `body ${body}`,
      `password=${SEEDS.password}&token=${SEEDS.apiToken}&code=${SEEDS.resetCode}`,
      `GET /api/v1/search?${SEEDS.query}`,
      `connect ${SEEDS.connection}`,
    ].join("\n"),
    { cause: new Error(`cause for ${SEEDS.email}`) },
  );
}

describe("the Sentry-protocol adapter", () => {
  it("sends one envelope per capture that holds none of the seeded secrets", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn, environment: "test" });

    await errors.capture(failureWithSeeds(), { requestId: "req-1", route: "POST /api/v1/widgets/{id}" });

    expect(sink.bodies).toHaveLength(1);
    const envelope = sink.bodies[0] ?? "";
    for (const [name, seed] of Object.entries(SEEDS)) {
      expect(envelope, name).not.toContain(seed);
    }
    expect(envelope).toContain('"type":"Error"');
    expect(envelope).toContain("handler failed for [email] from [ip]");
    expect(envelope).toContain('"transaction":"POST /api/v1/widgets/{id}"');
    expect(envelope).toContain("req-1");
    expect(envelope).not.toContain("breadcrumbs");
    expect(envelope).not.toContain('"request"');
    expect(envelope).not.toContain('"user"');
    expect(envelope).not.toContain("server_name");
  });

  it("is available, and reports the route template for the transaction name", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    expect(errors.available).toBe(true);
    await errors.capture(new Error("boom"), { route: "GET /api/v1/bookmarks/9b2f4c1e-5d3a-4e6f-8a7b-0c1d2e3f4a5b?x=1" });
    expect(sink.bodies[0]).toContain('"transaction":"GET /api/v1/bookmarks/{param}"');
  });

  it("redacts a JSON body embedded in an error message, escaped once or twice", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    const body = JSON.stringify({
      email: SEEDS.email,
      password: "spaced, quoted \\\"inner\\\" seedtail",
      cookie: SEEDS.cookie,
      note: "kept",
    });

    await errors.capture(new Error(`invalid payload ${JSON.stringify(body)}`));
    await errors.capture(new Error(`invalid payload ${JSON.stringify(JSON.stringify(body))}`));

    expect(sink.bodies).toHaveLength(2);
    for (const envelope of sink.bodies) {
      for (const leaked of [SEEDS.email, "spaced", "quoted", "inner", "seedtail", SEEDS.cookieValue, SEEDS.cookie]) {
        expect(envelope, leaked).not.toContain(leaked);
      }
      expect(envelope).toContain("invalid payload");
    }
  });

  it("redacts a value that ends in a backslash, escaped once or twice, as the last field", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    const body = JSON.stringify({ email: SEEDS.email, password: "correct-horse\\" });

    await errors.capture(new Error(`login ${body}`));
    await errors.capture(new Error(`login ${JSON.stringify(body)}`));
    await errors.capture(new Error(`login ${JSON.stringify(JSON.stringify(body))}`));

    expect(sink.bodies).toHaveLength(3);
    for (const envelope of sink.bodies) {
      for (const leaked of [SEEDS.email, "correct", "horse"]) {
        expect(envelope, leaked).not.toContain(leaked);
      }
      expect(envelope).toContain("login");
    }
  });

  it("redacts an escaped value longer than the scan used to look ahead", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    const key = `BEGINKEY${"k".repeat(2500)}ENDKEY`;
    const body = JSON.stringify({ private_key: key, note: "kept" });

    await errors.capture(new Error(`import ${JSON.stringify(body)}`));
    await errors.capture(new Error(`import ${JSON.stringify(JSON.stringify({ private_key: key }))}`));

    expect(sink.bodies).toHaveLength(2);
    for (const envelope of sink.bodies) {
      expect(envelope).not.toContain("BEGINKEY");
      expect(envelope).not.toContain("ENDKEY");
      expect(envelope).not.toContain("kkkkkkkk");
      expect(envelope).toContain("import");
    }
  });

  it("redacts a value that the length cap cuts, with no prefix of it left", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    const secret = `CUTSEED${"s".repeat(300)}`;
    const padding = "x ".repeat(2020);
    const plain = JSON.stringify({ password: secret });

    await errors.capture(new Error(`${padding}${plain}`));
    await errors.capture(new Error(`${padding}${JSON.stringify(plain)}`));
    await errors.capture(new Error(`${padding}password=${secret}`));

    expect(sink.bodies).toHaveLength(3);
    for (const envelope of sink.bodies) {
      expect(envelope).not.toContain("CUTSEED");
      expect(envelope).not.toContain("sssss");
      expect(envelope).toContain("x x x");
    }
  });

  it("redacts a value whose tail the URL steps would otherwise cut, plain and escaped", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    const withQuery = JSON.stringify({ password: 'k9/x#"Pq7queryTAIL' });
    const withAt = JSON.stringify({ returnTo: "https://example.com", password: "hunter@zz9atTAIL" });
    const withIssuer = JSON.stringify({ issuer: "https://idp.example.com", clientSecret: "s@ecretAtTAIL" });

    for (const body of [withQuery, withAt, withIssuer]) {
      await errors.capture(new Error(`bad ${body}`));
      await errors.capture(new Error(`bad ${JSON.stringify(body)}`));
      await errors.capture(new Error(`bad ${JSON.stringify(JSON.stringify(body))}`));
    }
    await errors.capture(new Error("bad /login?next=https://example.com&password=hunter@zz9atTAIL&x=1"));

    expect(sink.bodies).toHaveLength(10);
    for (const envelope of sink.bodies) {
      for (const leaked of ["Pq7", "queryTAIL", "zz9", "atTAIL", "hunter", "ecretAt"]) {
        expect(envelope, leaked).not.toContain(leaked);
      }
      expect(envelope).toContain("bad");
    }
  });

  it("redacts an array or object under a redacted key up to its matching close bracket, plain and escaped", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    const bodies = [
      JSON.stringify({ codes: ["backupSEED1", "backupSEED2"], note: "kept" }),
      JSON.stringify({ credentials: { password: "objSEED1", extra: ["objSEED2", { deep: "objSEED3" }] }, note: "kept" }),
      JSON.stringify({ codes: ["a]b", "c}d\\", "tail-5"], note: "kept" }),
    ];

    for (const body of bodies) {
      await errors.capture(new Error(`bad ${body}`));
      await errors.capture(new Error(`bad ${JSON.stringify(body)}`));
      await errors.capture(new Error(`bad ${JSON.stringify(JSON.stringify(body))}`));
    }
    await errors.capture(new Error('bad {"codes":["unclosed-1","unclosed-2"'));

    expect(sink.bodies).toHaveLength(10);
    for (const envelope of sink.bodies) {
      for (const leaked of ["backupSEED", "objSEED", "tail-5", "c}d", "a]b", "unclosed"]) {
        expect(envelope, leaked).not.toContain(leaked);
      }
      expect(envelope).toContain("bad");
    }
    for (const envelope of sink.bodies.slice(0, 9)) {
      expect(envelope).toContain("kept");
    }
  });

  it("redacts a Bearer or Basic credential behind a redacted key, whatever its length", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    const inputs = [
      "X-Api-Key: Bearer seedBEARERcred1234",
      "api_key: Basic c2VlZEJBU0lDY3JlZDEyMzQ=",
      "token=Bearer seedBEARERcred1234",
      "client_secret = Bearer seedBEARERcred1234",
      "X-Api-Key: Bearer shrt7q",
    ];

    for (const input of inputs) {
      await errors.capture(new Error(`call failed ${input} after`));
    }

    expect(sink.bodies).toHaveLength(inputs.length);
    for (const envelope of sink.bodies) {
      for (const leaked of ["seedBEARER", "cred1234", "c2VlZEJB", "shrt7q"]) {
        expect(envelope, leaked).not.toContain(leaked);
      }
      expect(envelope).toContain("call failed");
    }
  });

  it("redacts a value that holds a close bracket inside a single-quoted string, as util.inspect prints it", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    const inputs = [
      inspect({ credentials: { password: "p}w0rdSEEDtail", user: "u" } }),
      inspect({ codes: ["a]bSEEDone", "code2SEEDtwo"] }),
      inspect({ credentials: { password: "it's}SEEDq", user: "u" } }),
    ];

    for (const input of inputs) {
      await errors.capture(new Error(`bad ${input}`));
    }

    expect(sink.bodies).toHaveLength(inputs.length);
    for (const envelope of sink.bodies) {
      for (const leaked of ["w0rdSEED", "SEEDtail", "SEEDone", "code2SEED", "SEEDtwo", "SEEDq"]) {
        expect(envelope, leaked).not.toContain(leaked);
      }
      expect(envelope).toContain("bad");
    }
  });

  it("redacts a value util.inspect prints between backticks, because it holds both kinds of quote", async () => {
    const sink = await startSink();
    const errors = createSentryErrorReport({ dsn: sink.dsn });
    const inputs = [
      inspect({ user: "u", password: "ab'cd\"SEEDtail" }),
      inspect({ credentials: { password: "p}SEEDtail'\"", user: "u" } }),
      inspect({ token: ["x]SEEDtail'\"", "y"] }),
      inspect({ password: "a'b\"c`d}SEEDall]" }),
    ];
    expect(inputs.slice(0, 3).every((input) => input.includes("`"))).toBe(true);

    for (const input of inputs) {
      await errors.capture(new Error(`bad ${input}`));
    }

    expect(sink.bodies).toHaveLength(inputs.length);
    for (const envelope of sink.bodies) {
      for (const leaked of ["SEEDtail", "SEEDall", "ab'cd", "cd\\\"", "tail'"]) {
        expect(envelope, leaked).not.toContain(leaked);
      }
      expect(envelope).toContain("bad");
    }
  });

  it("sends nothing when the sink is down, and the capture still resolves", async () => {
    const sink = await startSink();
    const { dsn } = sink;
    await sink.close();
    sinks.length = 0;
    const errors = createSentryErrorReport({ dsn, flushTimeoutMs: 500 });
    await expect(errors.capture(new Error("boom"))).resolves.toBeUndefined();
  });

  it.each(["", "not a dsn", "https://example.com/1", "https://key@example.com/not-a-project"])(
    "refuses the DSN %j without naming it",
    (dsn) => {
      expect(() => createSentryErrorReport({ dsn })).toThrow("ERROR_REPORT_DSN is not a valid Sentry DSN");
    },
  );
});

describe("scrubEvent", () => {
  const event = {
    event_id: "0123456789abcdef0123456789abcdef",
    message: `login failed for ${SEEDS.email}`,
    server_name: "host-seed",
    transaction: `GET /api/v1/reset/${SEEDS.resetCode}?${SEEDS.query}`,
    request: {
      method: "post",
      url: `https://slugbase.example.com/api/v1/reset?${SEEDS.query}`,
      query_string: SEEDS.query,
      cookies: { sb_session: SEEDS.cookieValue },
      headers: { authorization: SEEDS.bearer, cookie: SEEDS.cookie, "user-agent": "agent" },
      data: { password: SEEDS.password },
    },
    user: { id: "u1", email: SEEDS.email, ip_address: SEEDS.clientIp },
    breadcrumbs: [{ message: SEEDS.password }],
    tags: { request_id: "req-1", password: SEEDS.password },
    extra: { nested: { accessToken: SEEDS.apiToken, resetCode: SEEDS.resetCode, apiKey: "seed-key", list: [`x ${SEEDS.email}`] } },
    exception: { values: [{ type: "Error", value: `cookie: ${SEEDS.cookie}; ip ${SEEDS.clientIp}`, stacktrace: { frames: [{ filename: "/srv/app/a.ts", lineno: 3 }] } }] },
  };

  it("drops the request body, query string, cookies and headers, the user, the host and the breadcrumbs", () => {
    const scrubbed = scrubEvent(event) as Record<string, unknown>;
    expect(scrubbed["request"]).toEqual({ method: "POST" });
    expect(scrubbed).not.toHaveProperty("user");
    expect(scrubbed).not.toHaveProperty("server_name");
    expect(scrubbed).not.toHaveProperty("breadcrumbs");
    expect(scrubbed["transaction"]).toBe("GET /api/v1/reset/{param}");
  });

  it("filters every value under a key on the redaction list, at any depth", () => {
    const scrubbed = scrubEvent(event);
    expect(scrubbed.tags).toEqual({ request_id: "req-1", password: "[Filtered]" });
    expect(scrubbed.extra.nested).toEqual({
      accessToken: "[Filtered]",
      resetCode: "[Filtered]",
      apiKey: "[Filtered]",
      list: ["x [email]"],
    });
  });

  it("leaves no seeded value anywhere in the event", () => {
    const text = JSON.stringify(scrubEvent(event));
    for (const [name, seed] of Object.entries(SEEDS)) {
      expect(text, name).not.toContain(seed);
    }
    expect(text).toContain("/srv/app/a.ts");
  });

  it("does not change the event it is given", () => {
    const before = JSON.stringify(event);
    scrubEvent(event);
    expect(JSON.stringify(event)).toBe(before);
  });
});

describe("scrubText", () => {
  it.each([
    ["mail alice@example.com now", "mail [email] now"],
    ["from 10.0.0.12 and 2001:db8::7 and fe80:0:0:0:1:2:3:4", "from [ip] and [ip] and [ip]"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "Authorization: [Filtered]"],
    ["token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig_seed", "token [Filtered]"],
    ['{"password":"hunter2","note":"ok"}', '{"password":"[Filtered]","note":"ok"}'],
    ["secret=abc&page=2", "secret=[Filtered]&page=2"],
    ["https://u:pw@host.example/x", "https://[Filtered]@host.example/x"],
    ["GET /a/b?token=zzz#frag", "GET /a/b"],
    ["at 12:30:45 Foo::bar std::vector", "at 12:30:45 Foo::bar std::vector"],
    ['{\\"password\\":\\"hunter2\\",\\"note\\":\\"ok\\"}', '{\\"password\\":\\"[Filtered]\\",\\"note\\":\\"ok\\"}'],
    ['{\\"password\\":\\"a, b c\\"}', '{\\"password\\":\\"[Filtered]\\"}'],
    ['{\\\\\\"token\\\\\\":\\\\\\"a b, c\\\\\\",\\\\\\"n\\\\\\":1}', '{\\\\\\"token\\\\\\":\\\\\\"[Filtered]\\\\\\",\\\\\\"n\\\\\\":1}'],
    ['{\\"cookie\\":\\"sb_session=abc\\"}', '{\\"cookie\\":[Filtered]'],
    ['{\\"password\\":\\"hunter2\\\\\\\\\\"}', '{\\"password\\":\\"[Filtered]\\"}'],
    ['{\\"password\\":\\"hunter2\\\\\\"x\\"}', '{\\"password\\":\\"[Filtered]\\"}'],
    ['{\\"password\\":\\"hunter2', '{\\"password\\":\\"[Filtered]'],
    ['{"password":"hunter2\\\\"}', '{"password":"[Filtered]"}'],
    ['{"codes":["1-2","3-4"],"n":1}', '{"codes":[Filtered],"n":1}'],
    ['{"credentials":{"password":"a]b","x":[1]},"n":1}', '{"credentials":[Filtered],"n":1}'],
    ['{\\"codes\\":[\\"1-2\\",\\"3]4\\"],\\"n\\":1}', '{\\"codes\\":[Filtered],\\"n\\":1}'],
    ['{"codes":["1-2","3-4"', '{"codes":[Filtered]'],
    ['{"password":"k9/x#\\"Pq7tail"}', '{"password":"[Filtered]"}'],
    ['{"a":"https://example.com","password":"h@zz9"}', '{"a":"https://example.com","password":"[Filtered]"}'],
    ['{"data":"{\\"password\\":\\"hunter2\\"}"}', '{"data":"{\\"password\\":\\"[Filtered]\\"}"}'],
  ])("rewrites %j", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it("stays fast on a bracket-heavy input of 4096 characters", () => {
    for (const unit of ['"codes":[', '"k":{"a":[', '\\"token\\":[{\\"', "secret=[[[[", 'key:["]', "code={'"]) {
      const input = unit.repeat(Math.ceil(4096 / unit.length)).slice(0, 4096);
      const started = performance.now();
      scrubText(input);
      expect(performance.now() - started, unit).toBeLessThan(1000);
    }
  });

  it("stays fast on a long run of word characters", () => {
    const started = performance.now();
    scrubText("a".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each([
    ["backslashes", "password\\".repeat(1) + "\\".repeat(4000)],
    ["unterminated escaped values", 'password\\":\\"x '.repeat(300)],
    ["escaped openings", '\\"password\\":\\"'.repeat(250)],
    ["repeated names", "token\\\\\\\"=".repeat(500)],
    ["unterminated quotes", 'password="'.repeat(400)],
    ["long backslash runs before quotes", `password=${"\\".repeat(2000)}"${"\\".repeat(2000)}"`],
  ])("stays fast on %s", (_name, input) => {
    const started = performance.now();
    scrubText(input);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// Every shape of secret, in every wrapper a message can carry it in, under every key family: no run of six
// characters of the secret may survive the scrubber, with or without the length cap cutting through it.
describe("scrubText over secret shapes, wrappers and keys", () => {
  const CAP = 4096;
  const pseudoRandom = (length: number): string => {
    let state = 12345;
    let out = "qzxlong";
    while (out.length < length) {
      state = (state * 1103515245 + 12345) % 2147483648;
      out += (state % 36).toString(36);
    }
    return out;
  };

  // `probe` is the part of the value that must not survive. `delimiterFree` marks the values a bare
  // `name=value` or `name: value` can hold: without a quote, the scrubber cannot tell where a value with
  // whitespace, a quote, a close bracket or a comma ends, so those shapes are tried in every quoted wrapper only.
  const shapes: { name: string; value: string; probe: string; delimiterFree: boolean }[] = [
    { name: "plain", value: "qzxplainv9k7w3", probe: "qzxplainv9k7w3", delimiterFree: true },
    { name: "spaces", value: "qzx spaced vwk fraze tail9", probe: "qzx spaced vwk fraze tail9", delimiterFree: false },
    { name: "trailing backslash", value: "qzxslashv9k7w3\\", probe: "qzxslashv9k7w3\\", delimiterFree: true },
    {
      name: "contains ' and \"",
      value: "qzx7'vwk\"9tail",
      probe: "qzx7'vwk\"9tail",
      delimiterFree: false,
    },
    {
      name: "contains ' and \" and a close bracket",
      value: "qzx7'vwk\"9}tail]",
      probe: "qzx7'vwk\"9}tail]",
      delimiterFree: false,
    },
    {
      name: "contains all three quotes and a close bracket",
      value: "qzx7'vwk\"9`tail}]",
      probe: "qzx7'vwk\"9`tail}]",
      delimiterFree: false,
    },
    ..."\"'`}]#?@/,".split("").map((char) => ({
      name: `contains ${char}`,
      value: `qzx7${char}vwk9tail`,
      probe: `qzx7${char}vwk9tail`,
      delimiterFree: !"\"'}],".includes(char),
    })),
    { name: "over 2048 characters", value: pseudoRandom(2300), probe: pseudoRandom(2300), delimiterFree: true },
    { name: "bearer", value: "Bearer qzxbearerv9k7w3", probe: "qzxbearerv9k7w3", delimiterFree: true },
    { name: "basic", value: "Basic cXp4YmFzaWN2OWs3dzM=", probe: "cXp4YmFzaWN2OWs3dzM=", delimiterFree: true },
    { name: "short bearer", value: "Bearer qzx7k3", probe: "qzx7k3", delimiterFree: true },
  ];

  const keys = [
    "password",
    "passwd",
    "passphrase",
    "accessToken",
    "client_secret",
    "resetCode",
    "apiKey",
    "X-Api-Key",
    "authorization",
    "cookie",
    "credentials",
  ];

  const pythonQuoted = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const twice = (text: string): string => JSON.stringify(JSON.stringify(text));
  const once = (text: string): string => JSON.stringify(text);

  type Wrapper = { name: string; unquoted?: true; build: (key: string, value: string) => string };
  const wrappers: Wrapper[] = [
    { name: "key=value", unquoted: true, build: (key, value) => `fail ${key}=${value}` },
    { name: "key: value", unquoted: true, build: (key, value) => `fail ${key}: ${value}` },
    { name: "after a URL, key=value", unquoted: true, build: (key, value) => `GET https://example.com ${key}=${value}` },
    { name: '"key":"value"', build: (key, value) => `fail {"${key}":${once(value)},"z":1}` },
    { name: "'key': 'value'", build: (key, value) => `fail {'${key}': ${pythonQuoted(value)}, 'z': 1}` },
    { name: "key: 'value'", build: (key, value) => `fail { ${key}: ${pythonQuoted(value)}, z: 1 }` },
    { name: "inspect object", build: (key, value) => `fail ${inspect({ [key]: value, z: 1 })}` },
    { name: "inspect nested", build: (key, value) => `fail ${inspect({ a: { [key]: value, z: 1 }, y: 2 })}` },
    { name: "inspect array", build: (key, value) => `fail ${inspect([{ [key]: value, z: 1 }, "second"])}` },
    { name: "inspect array value", build: (key, value) => `fail ${inspect({ [key]: [value, "second"], z: 1 })}` },
    { name: "after a URL, inspect", build: (key, value) => `GET https://example.com ${inspect({ [key]: value, z: 1 })}` },
    { name: "JSON object", build: (key, value) => `fail ${JSON.stringify({ [key]: value, z: 1 })}` },
    { name: "JSON nested", build: (key, value) => `fail ${JSON.stringify({ a: { [key]: value, z: 1 }, y: 2 })}` },
    { name: "JSON array", build: (key, value) => `fail ${JSON.stringify([{ [key]: value, z: 1 }, "second"])}` },
    { name: "JSON array value", build: (key, value) => `fail ${JSON.stringify({ [key]: [value, "second"], z: 1 })}` },
    {
      name: "after a URL, JSON",
      build: (key, value) => `fail ${JSON.stringify({ u: "https://example.com", [key]: value, z: 1 })}`,
    },
  ];
  for (const inner of wrappers.filter((wrapper) => wrapper.name.includes("JSON"))) {
    wrappers.push(
      { name: `${inner.name}, stringified once`, build: (key, value) => once(inner.build(key, value)) },
      { name: `${inner.name}, stringified twice`, build: (key, value) => twice(inner.build(key, value)) },
    );
  }

  // The escaped forms a secret takes when the message holding it is JSON-stringified once or twice.
  const forms = (probe: string): string[] => [probe, once(probe).slice(1, -1), twice(probe).slice(1, -1).slice(1, -1)];

  // Every window of six characters with at least three letters or digits, sampled for the long secret.
  const windows = (probe: string): string[] => {
    const found = new Set<string>();
    const step = probe.length > 256 ? Math.floor(probe.length / 80) : 1;
    for (let at = 0; at + 6 <= probe.length; at += step) {
      found.add(probe.slice(at, at + 6));
    }
    found.add(probe.slice(-6));
    return [...found].filter((window) => (window.match(/[A-Za-z0-9]/g) ?? []).length >= 3);
  };

  function survivors(output: string, probe: string): string[] {
    return forms(probe)
      .flatMap(windows)
      .filter((window) => output.includes(window));
  }

  function padFor(message: string, probe: string): string {
    const at = message.indexOf(probe.slice(0, 4));
    const cut = at + Math.min(Math.floor(probe.length / 2), 1000);
    const pad = CAP - cut;
    return pad > 0 ? "x ".repeat(Math.ceil(pad / 2)).slice(0, pad) : "";
  }

  it("leaves no six-character run of a secret behind", () => {
    const failures: string[] = [];
    let combinations = 0;
    for (const shape of shapes) {
      for (const key of keys) {
        for (const wrapper of wrappers) {
          if (wrapper.unquoted === true && !shape.delimiterFree) {
            continue;
          }
          const message = wrapper.build(key, shape.value);
          for (const cut of [false, true]) {
            const text = cut ? `${padFor(message, shape.probe)}${message}` : message;
            const output = scrubText(text);
            combinations += 1;
            const left = survivors(output, shape.probe);
            if (left.length > 0) {
              failures.push(`${shape.name} | ${key} | ${wrapper.name}${cut ? " | cut" : ""} -> ${JSON.stringify(left[0])}`);
            }
          }
        }
      }
    }
    expect(combinations).toBeGreaterThan(5000);
    expect(failures.slice(0, 25)).toEqual([]);
    expect(failures).toHaveLength(0);
  });
});

describe("routeTemplate", () => {
  it.each([
    ["GET /api/v1/widgets/{id}", "GET /api/v1/widgets/{id}"],
    ["/api/v1/widgets/:id", "/api/v1/widgets/:id"],
    ["GET https://slugbase.example.com/go/My-Slug_9?x=1#y", "GET /go/{param}"],
    ["GET /api/v1/bookmarks/123", "GET /api/v1/bookmarks/{param}"],
    ["mail.send", "mail.send"],
    ["seed.user@example.com", "{param}"],
  ])("reduces %j to %j", (name, template) => {
    expect(routeTemplate(name)).toBe(template);
  });
});

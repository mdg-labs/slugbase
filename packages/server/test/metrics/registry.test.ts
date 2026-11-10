import { describe, expect, it } from "vitest";
import { createMetrics, workerSamples } from "../../src/metrics/metrics.ts";
import { MetricsRegistry } from "../../src/metrics/registry.ts";

describe("MetricsRegistry", () => {
  it("renders counters, gauges and histograms in the Prometheus text format", async () => {
    const registry = new MetricsRegistry();
    registry.counter("things_total", "Things seen.", ["kind"]).increment({ kind: "a" });
    registry.gauge("level", "The level.").set({}, 3);
    registry.histogram("wait_seconds", "Wait.", ["route"], [0.1, 1]).observe({ route: "/x" }, 0.5);

    expect(await registry.render()).toBe(
      [
        "# HELP things_total Things seen.",
        "# TYPE things_total counter",
        'things_total{kind="a"} 1',
        "# HELP level The level.",
        "# TYPE level gauge",
        "level 3",
        "# HELP wait_seconds Wait.",
        "# TYPE wait_seconds histogram",
        'wait_seconds_bucket{route="/x",le="0.1"} 0',
        'wait_seconds_bucket{route="/x",le="1"} 1',
        'wait_seconds_bucket{route="/x",le="+Inf"} 1',
        'wait_seconds_sum{route="/x"} 0.5',
        'wait_seconds_count{route="/x"} 1',
        "",
      ].join("\n"),
    );
  });

  it("escapes quotes, backslashes and newlines in label values and help", async () => {
    const registry = new MetricsRegistry();
    registry.counter("c_total", "line one\nline two \\ end", ["v"]).increment({ v: 'a"b\\c\nd' });
    const text = await registry.render();
    expect(text).toContain("# HELP c_total line one\\nline two \\\\ end");
    expect(text).toContain('c_total{v="a\\"b\\\\c\\nd"} 1');
  });

  it("accepts only the labels a metric declared", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("c_total", "C.", ["route"]);
    const increment = (values: Record<string, string>): void => {
      counter.increment(values);
    };
    expect(() => {
      increment({ route: "/x", email: "a@b.c" });
    }).toThrow("takes the labels route");
    expect(() => {
      increment({});
    }).toThrow("takes the labels route");
    expect(() => {
      increment({ email: "a@b.c" });
    }).toThrow("takes the labels route");
  });

  it("refuses an invalid name, a reserved label and a duplicate metric", () => {
    const registry = new MetricsRegistry();
    expect(() => registry.counter("bad-name", "x")).toThrow("invalid metric name");
    expect(() => registry.counter("ok_total", "x", ["le"])).toThrow("invalid label name");
    registry.counter("ok_total", "x");
    expect(() => registry.gauge("ok_total", "x")).toThrow("registered twice");
  });

  it("runs collectors before rendering and fails the render when one fails", async () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge("g", "G.");
    let reading = 1;
    registry.onCollect(() => {
      gauge.set({}, reading);
    });
    expect(await registry.render()).toContain("g 1\n");
    reading = 2;
    expect(await registry.render()).toContain("g 2\n");

    registry.onCollect(() => Promise.reject(new Error("source down")));
    await expect(registry.render()).rejects.toThrow("source down");
  });

  describe("rendering attached registries", () => {
    const worker = { process: "worker" };

    function declare(registry: MetricsRegistry): { things: ReturnType<MetricsRegistry["counter"]>; level: ReturnType<MetricsRegistry["gauge"]>; wait: ReturnType<MetricsRegistry["histogram"]> } {
      return {
        things: registry.counter("things_total", "Things seen.", ["kind"]),
        level: registry.gauge("level", "The level."),
        wait: registry.histogram("wait_seconds", "Wait.", ["route"], [1]),
      };
    }

    function dataLines(text: string): string[] {
      return text.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    }

    it("declares a shared family once and gives the attached samples their constant labels", async () => {
      const server = new MetricsRegistry();
      const attached = new MetricsRegistry();
      const first = declare(server);
      const second = declare(attached);
      first.things.increment({ kind: "a" }, 2);
      second.things.increment({ kind: "a" }, 3);
      first.level.set({}, 10);
      second.level.set({}, 5);
      first.wait.observe({ route: "/x" }, 0.5);
      second.wait.observe({ route: "/x" }, 2);
      server.gauge("only_server", "Only the server.").set({}, 1);
      attached.gauge("only_worker", "Only the worker.").set({}, 7);

      const text = await server.render([{ registry: attached, labels: worker }]);

      const headers = text.split("\n").filter((line) => line.startsWith("# "));
      expect(new Set(headers).size).toBe(headers.length);
      const samples = dataLines(text);
      expect(new Set(samples.map((line) => line.slice(0, line.lastIndexOf(" ")))).size).toBe(samples.length);
      expect(text).toContain('things_total{kind="a"} 2\nthings_total{kind="a",process="worker"} 3\n');
      expect(text).toContain("level 10\nlevel{process=\"worker\"} 5\n");
      expect(text).toContain('wait_seconds_bucket{route="/x",le="1"} 1');
      expect(text).toContain('wait_seconds_bucket{route="/x",process="worker",le="1"} 0');
      expect(text).toContain('wait_seconds_count{route="/x",process="worker"} 1');
      expect(text).toContain("# HELP only_worker Only the worker.\n# TYPE only_worker gauge\nonly_worker{process=\"worker\"} 7\n");
      expect(text).toContain("only_server 1\n");
    });

    it("renders the primary registry exactly as before when nothing is attached", async () => {
      const server = new MetricsRegistry();
      declare(server).level.set({}, 1);
      expect(await server.render([])).toBe(await server.render());
      expect(await server.render()).not.toContain("process");
    });

    it("keeps the worker's pool and in-flight series beside the server's", async () => {
      const server = createMetrics();
      const attached = createMetrics();
      server.setPoolSize(10);
      attached.setPoolSize(5);
      attached.observeJobQueues(() => Promise.resolve([{ queue: "mail.send", deferred: 0, ready: 2, active: 1, oldestReadySeconds: 4 }]));

      const text = await server.registry.render([workerSamples(attached.registry)]);

      expect(text).toContain("slugbase_db_pool_size 10\nslugbase_db_pool_size{process=\"worker\"} 5\n");
      expect(text).toContain('slugbase_db_tenant_transactions_in_flight{process="worker"} 0');
      expect(text).toContain('slugbase_job_queue_depth{queue="mail.send",state="ready",process="worker"} 2');
      expect(text).toContain('slugbase_job_queue_oldest_ready_age_seconds{queue="mail.send",process="worker"} 4');
      expect(text.match(/^# TYPE slugbase_db_pool_size /gm)).toHaveLength(1);
    });

    it("fails the render when an attached registry's collector fails", async () => {
      const server = new MetricsRegistry();
      const attached = new MetricsRegistry();
      attached.onCollect(() => Promise.reject(new Error("queue source down")));
      await expect(server.render([{ registry: attached, labels: worker }])).rejects.toThrow("queue source down");
    });

    it("refuses to merge a family declared differently, a label the family already has and an ambiguous label set", async () => {
      const server = new MetricsRegistry();
      server.counter("things_total", "Things seen.", ["kind"]);

      const retyped = new MetricsRegistry();
      retyped.gauge("things_total", "Things seen.", ["kind"]);
      await expect(server.render([{ registry: retyped, labels: worker }])).rejects.toThrow("declared differently");

      const relabelled = new MetricsRegistry();
      relabelled.counter("things_total", "Things seen.", ["kind"]);
      await expect(server.render([{ registry: relabelled, labels: { kind: "x" } }])).rejects.toThrow("already has a label");

      await expect(server.render([{ registry: relabelled, labels: {} }])).rejects.toThrow("constant labels");
      await expect(
        server.render([
          { registry: relabelled, labels: worker },
          { registry: new MetricsRegistry(), labels: worker },
        ]),
      ).rejects.toThrow("constant labels");
      await expect(server.render([{ registry: relabelled, labels: { le: "1" } }])).rejects.toThrow("invalid label name");
    });
  });
});

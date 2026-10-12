import { describe, expect, it } from "vitest";
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
});

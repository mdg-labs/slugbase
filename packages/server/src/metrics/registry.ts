// A small Prometheus text-format registry (exposition format 0.0.4). The
// metrics of doc 01 section 12 are few and fixed, so the registry holds just
// the three types they need. A metric declares its label names once; a sample
// is addressed by values for exactly those names, so a label that was not
// declared cannot appear (doc 10 T7).

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export type LabelValues = Readonly<Record<string, string>>;

function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "+Inf" : "-Inf";
  }
  return String(value);
}

abstract class Metric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];

  constructor(name: string, help: string, labelNames: readonly string[]) {
    if (!METRIC_NAME.test(name)) {
      throw new Error(`invalid metric name ${name}`);
    }
    for (const label of labelNames) {
      if (!LABEL_NAME.test(label) || label === "le" || label.startsWith("__")) {
        throw new Error(`invalid label name ${label} on ${name}`);
      }
    }
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  protected keyOf(values: LabelValues): string {
    const given = Object.keys(values);
    if (given.length !== this.labelNames.length || !this.labelNames.every((label) => label in values)) {
      throw new Error(`${this.name} takes the labels ${this.labelNames.join(", ") || "(none)"}`);
    }
    return JSON.stringify(this.labelNames.map((label) => values[label]));
  }

  protected pairs(key: string, extra: readonly (readonly [string, string])[] = []): string {
    const values = JSON.parse(key) as string[];
    const all = [...this.labelNames.map((label, index) => [label, values[index] ?? ""] as const), ...extra];
    return all.length === 0 ? "" : `{${all.map(([label, value]) => `${label}="${escapeLabelValue(value)}"`).join(",")}}`;
  }

  protected header(type: "counter" | "gauge" | "histogram"): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${type}`];
  }

  abstract render(): string[];
}

export class Counter extends Metric {
  readonly #samples = new Map<string, number>();

  increment(values: LabelValues = {}, by = 1): void {
    const key = this.keyOf(values);
    this.#samples.set(key, (this.#samples.get(key) ?? 0) + by);
  }

  render(): string[] {
    return [...this.header("counter"), ...[...this.#samples].map(([key, value]) => `${this.name}${this.pairs(key)} ${formatNumber(value)}`)];
  }
}

export class Gauge extends Metric {
  #samples = new Map<string, number>();

  set(values: LabelValues, value: number): void {
    this.#samples.set(this.keyOf(values), value);
  }

  /** Drops every sample, for a gauge a collector refills at each scrape. */
  clear(): void {
    this.#samples = new Map();
  }

  render(): string[] {
    return [...this.header("gauge"), ...[...this.#samples].map(([key, value]) => `${this.name}${this.pairs(key)} ${formatNumber(value)}`)];
  }
}

interface HistogramSample {
  readonly counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends Metric {
  readonly #bounds: readonly number[];
  readonly #samples = new Map<string, HistogramSample>();

  constructor(name: string, help: string, labelNames: readonly string[], bounds: readonly number[]) {
    super(name, help, labelNames);
    this.#bounds = [...bounds].sort((a, b) => a - b);
  }

  observe(values: LabelValues, value: number): void {
    const key = this.keyOf(values);
    let sample = this.#samples.get(key);
    if (sample === undefined) {
      sample = { counts: this.#bounds.map(() => 0), sum: 0, count: 0 };
      this.#samples.set(key, sample);
    }
    for (const [index, bound] of this.#bounds.entries()) {
      if (value <= bound) {
        sample.counts[index] = (sample.counts[index] ?? 0) + 1;
      }
    }
    sample.sum += value;
    sample.count += 1;
  }

  render(): string[] {
    const lines = this.header("histogram");
    for (const [key, sample] of this.#samples) {
      for (const [index, bound] of this.#bounds.entries()) {
        lines.push(`${this.name}_bucket${this.pairs(key, [["le", formatNumber(bound)]])} ${formatNumber(sample.counts[index] ?? 0)}`);
      }
      lines.push(`${this.name}_bucket${this.pairs(key, [["le", "+Inf"]])} ${formatNumber(sample.count)}`);
      lines.push(`${this.name}_sum${this.pairs(key)} ${formatNumber(sample.sum)}`);
      lines.push(`${this.name}_count${this.pairs(key)} ${formatNumber(sample.count)}`);
    }
    return lines;
  }
}

export type Collector = () => void | Promise<void>;

export class MetricsRegistry {
  readonly #metrics = new Map<string, Metric>();
  readonly #collectors: Collector[] = [];

  #add<M extends Metric>(metric: M): M {
    if (this.#metrics.has(metric.name)) {
      throw new Error(`metric ${metric.name} is registered twice`);
    }
    this.#metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.#add(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.#add(new Gauge(name, help, labelNames));
  }

  histogram(name: string, help: string, labelNames: readonly string[], bounds: readonly number[]): Histogram {
    return this.#add(new Histogram(name, help, labelNames, bounds));
  }

  /** Runs before each render, to set the gauges whose source is read at scrape time. */
  onCollect(collector: Collector): void {
    this.#collectors.push(collector);
  }

  /** The exposition text. A collector that fails fails the render: a scrape never reads a half-filled gauge as a value. */
  async render(): Promise<string> {
    for (const collector of this.#collectors) {
      await collector();
    }
    return `${[...this.#metrics.values()].flatMap((metric) => metric.render()).join("\n")}\n`;
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { RPReporter } from "@reportportal/agent-js-vitest";
import type { RunnerTestFile } from "vitest";
import type { TestModule } from "vitest/node";
import { ReportPortalVitest4Reporter } from "./reportportal-vitest4-adapter.js";

describe("ReportPortalVitest4Reporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards Vitest 4 hooks to the agent-js-vitest reporter", async () => {
    const inner = {
      onInit: vi.fn(),
      onCollected: vi.fn(),
      onTaskUpdate: vi.fn(),
      onUserConsoleLog: vi.fn(),
      onFinished: vi.fn().mockResolvedValue(undefined),
      config: { launch: "SlugBase · Unit" },
    } as unknown as RPReporter;

    const adapter = Object.create(
      ReportPortalVitest4Reporter.prototype,
    ) as ReportPortalVitest4Reporter;
    Object.defineProperty(adapter, "inner", { value: inner });

    const vitest = {} as never;
    const task = { filepath: "/proj/foo.spec.ts", name: "foo.spec.ts" } as RunnerTestFile;
    const testModule = { task } as TestModule;
    const packs = [] as never;

    adapter.onInit(vitest);
    adapter.onTestModuleCollected(testModule);
    adapter.onTaskUpdate(packs);
    adapter.onUserConsoleLog({ content: "log", taskId: "1", time: 0, type: "stdout" });
    await adapter.onTestRunEnd([], [], "passed");

    expect(inner.onInit).toHaveBeenCalledWith(vitest);
    expect(inner.onCollected).toHaveBeenCalledWith([task]);
    expect(inner.onTaskUpdate).toHaveBeenCalledWith(packs);
    expect(inner.onUserConsoleLog).toHaveBeenCalled();
    expect(inner.onFinished).toHaveBeenCalled();
    expect(adapter.config.launch).toBe("SlugBase · Unit");
  });
});

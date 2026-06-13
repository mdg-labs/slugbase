import { RPReporter } from "@reportportal/agent-js-vitest";
import type {
  RunnerTaskResultPack,
  RunnerTestFile,
  UserConsoleLog,
} from "vitest";
import type {
  SerializedError,
  TestModule,
  TestRunEndReason,
  Vitest,
} from "vitest/node";

type ReportPortalClientConfig = ConstructorParameters<typeof RPReporter>[0];

/** TestModule.task is internal in Vitest 4 types but required by agent-js-vitest. */
type TestModuleWithRunnerTask = TestModule & { task: RunnerTestFile };

function runnerTestFile(testModule: TestModule): RunnerTestFile {
  return (testModule as TestModuleWithRunnerTask).task;
}

/**
 * Bridges Vitest 4 reporter hooks to @reportportal/agent-js-vitest (Vitest 1–3 API).
 *
 * Vitest 4 renamed onCollected → onTestModuleCollected and onFinished → onTestRunEnd.
 * Without this shim the agent starts a launch (onInit) but never records test items.
 */
export class ReportPortalVitest4Reporter {
  readonly inner: RPReporter;

  constructor(config: ReportPortalClientConfig) {
    this.inner = new RPReporter(config);
  }

  get config(): ReportPortalClientConfig {
    return this.inner.config;
  }

  onInit(vitestInstance: Vitest): void {
    this.inner.onInit(vitestInstance);
  }

  onTestModuleCollected(testModule: TestModule): void {
    this.inner.onCollected([runnerTestFile(testModule)]);
  }

  onTaskUpdate(packs: RunnerTaskResultPack[]): void {
    this.inner.onTaskUpdate(packs);
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    this.inner.onUserConsoleLog(log);
  }

  async onTestRunEnd(
    _testModules: ReadonlyArray<TestModule>,
    _unhandledErrors: ReadonlyArray<SerializedError>,
    _reason: TestRunEndReason,
  ): Promise<void> {
    await this.inner.onFinished();
  }
}

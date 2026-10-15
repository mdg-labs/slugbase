export type MatrixMode = "api" | "rls-only" | "token";

export interface MatrixFailure {
  readonly mode: MatrixMode;
  /** What the failure is about: an operation, or a repository method. */
  readonly subject: string;
  readonly kind: string;
  readonly detail: string;
}

export class MatrixFailureError extends Error {
  readonly failures: readonly MatrixFailure[];

  constructor(failures: readonly MatrixFailure[]) {
    super(formatFailures(failures));
    this.name = "MatrixFailureError";
    this.failures = failures;
  }
}

export function formatFailures(failures: readonly MatrixFailure[]): string {
  const lines = failures.map((failure) => `- [${failure.mode}] ${failure.subject}: ${failure.kind}: ${failure.detail}`);
  return `the cross-tenant matrix failed with ${String(failures.length)} failure(s):\n${lines.join("\n")}`;
}

/** Throws when a report holds a failure. */
export function assertMatrixPassed(report: { readonly failures: readonly MatrixFailure[] }): void {
  if (report.failures.length > 0) {
    throw new MatrixFailureError(report.failures);
  }
}

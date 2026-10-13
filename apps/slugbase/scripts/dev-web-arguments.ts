import { constants } from "node:os";

const MOCK_FLAG = "--mock";

/** The arguments of `pnpm dev:web` as Vite takes them: `--mock` becomes `--mode mock`, the rest goes through. */
export function viteArguments(argv: readonly string[]): string[] {
  const forwarded = argv.filter((argument) => argument !== MOCK_FLAG);
  return argv.includes(MOCK_FLAG) ? [...forwarded, "--mode", "mock"] : forwarded;
}

/**
 * The exit code `pnpm dev:web` passes on from Vite: Vite's own code, or 128 plus
 * the signal number when a signal ended it (130 for SIGINT, 143 for SIGTERM), as
 * a shell reports it.
 */
export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) {
    return code;
  }
  return signal === null ? 1 : 128 + constants.signals[signal];
}

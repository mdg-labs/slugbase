const MOCK_FLAG = "--mock";

/** The arguments of `pnpm dev:web` as Vite takes them: `--mock` becomes `--mode mock`, the rest goes through. */
export function viteArguments(argv: readonly string[]): string[] {
  const forwarded = argv.filter((argument) => argument !== MOCK_FLAG);
  return argv.includes(MOCK_FLAG) ? [...forwarded, "--mode", "mock"] : forwarded;
}

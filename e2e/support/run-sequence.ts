export const DRILL = ["--config", "restore-drill.config.ts"];
export const PROXY_DRILL = ["--config", "reverse-proxy.config.ts"];

export interface Sequence {
  /** The arguments after the script name, with a leading `--` already dropped. */
  forwarded: readonly string[];
  /** Whether the run is inside the Playwright image, which has no docker for the drills. */
  inImage: boolean;
  /** Runs Playwright with the arguments and resolves with the exit status it ended with. */
  run: (playwrightArgs: readonly string[]) => Promise<number>;
  /** Whether an interrupt or a termination reached this process. */
  interrupted: () => boolean;
  /** Writes a line to the run's standard error. */
  note: (message: string) => void;
}

/** Runs the journeys and the drills in order and returns the exit status of the whole run. */
export async function runSequence({ forwarded, inImage, run, interrupted, note }: Sequence): Promise<number> {
  if (forwarded[0] === "restore-drill") {
    return run([...DRILL, ...forwarded.slice(1)]);
  }
  if (forwarded[0] === "reverse-proxy") {
    return run([...PROXY_DRILL, ...forwarded.slice(1)]);
  }
  const journeys = await run(forwarded);
  if (forwarded.length > 0 || interrupted()) {
    return journeys;
  }
  if (inImage) {
    note(
      "the restore drill and the reverse proxy drill need docker and are not run in the Playwright image; run `pnpm test:e2e restore-drill` and `pnpm test:e2e reverse-proxy` on the host\n",
    );
    return journeys;
  }
  // The drills run even when a journey failed, so that one run reports all of them.
  const drill = await run(DRILL);
  if (interrupted()) {
    return journeys !== 0 ? journeys : drill;
  }
  const proxyDrill = await run(PROXY_DRILL);
  return journeys !== 0 ? journeys : drill !== 0 ? drill : proxyDrill;
}

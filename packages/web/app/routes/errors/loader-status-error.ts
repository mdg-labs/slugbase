/**
 * Typed error thrown from route loaders to surface a specific HTTP status
 * without falling through to the generic 500 path.
 */
export class LoaderStatusError extends Error {
  override readonly name = "LoaderStatusError";
  constructor(public readonly status: number) {
    super("Loader error " + String(status));
  }
}

import type { Port } from "./port.ts";

export interface ClientErrorReportRequest {
  readonly accountId: string;
  /** The account's active workspace; undefined when it has none. */
  readonly workspaceId: string | undefined;
}

/**
 * Supplies the public DSN a browser error reporter needs (doc 01 section 13.4).
 * The unconfigured default answers `null`: no field in the account profile and
 * no browser reporter.
 */
export interface ClientErrorReportPort extends Port {
  dsn(request: ClientErrorReportRequest): Promise<string | null>;
}

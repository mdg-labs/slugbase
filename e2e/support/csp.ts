import { expect, type Page } from "@playwright/test";

/** A Content Security Policy violation a page reported, or a console message that names one. */
export interface CspViolation {
  readonly source: "event" | "console";
  readonly detail: string;
}

export interface CspWatch {
  /** What the page has reported since the watch began. */
  violations: () => readonly CspViolation[];
}

interface ViolationEventData {
  readonly directive: string;
  readonly blocked: string;
  readonly file: string;
  readonly line: number;
  readonly sample: string;
}

const CONSOLE_PATTERN = /content[ -]security[ -]policy/i;

const REPORT = "__reportCspViolation";

/**
 * Starts recording the policy violations of a page, from the `securitypolicyviolation` event of every
 * document it loads (all three engines fire it) and from the console messages that name the policy
 * (Chromium and Firefox print one for each). Call it before the page's first navigation: the event
 * listener is installed in each document before its own scripts run.
 */
export async function watchCsp(page: Page): Promise<CspWatch> {
  const seen: CspViolation[] = [];
  await page.exposeFunction(REPORT, (data: ViolationEventData) => {
    seen.push({
      source: "event",
      detail: `${data.directive} blocked ${data.blocked} at ${data.file}:${String(data.line)} ${data.sample}`.trim(),
    });
  });
  await page.addInitScript((report) => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const send = (window as unknown as Record<string, (data: ViolationEventData) => void>)[report];
      send?.({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        file: event.sourceFile,
        line: event.lineNumber,
        sample: event.sample,
      });
    });
  }, REPORT);
  page.on("console", (message) => {
    if (CONSOLE_PATTERN.test(message.text())) {
      seen.push({ source: "console", detail: message.text() });
    }
  });
  return { violations: () => seen };
}

/** Fails when the page reported a policy violation since the watch began. */
export function expectNoCspViolations(watch: CspWatch, where: string): void {
  expect(watch.violations(), `Content Security Policy violations on ${where}`).toEqual([]);
}

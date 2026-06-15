import { useTranslation } from "react-i18next";
import { useCallback, useRef, useState } from "react";

import {
  type ImportResult,
  detectFileType,
  importJson,
  importNetscapeHtml,
  readFileAsText,
} from "./import-api.js";

const ONBOARDING_DONE_KEY = "sb_onboarding_done";

export function isOnboardingDone(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(ONBOARDING_DONE_KEY) === "true";
  } catch {
    return true;
  }
}

export function markOnboardingDone(): void {
  try {
    window.localStorage.setItem(ONBOARDING_DONE_KEY, "true");
  } catch {
    /* ignore */
  }
}

const SHORTCUT_URL = "/go/%s";

type ImportState =
  | { phase: "idle" }
  | { phase: "ready"; file: File }
  | { phase: "importing" }
  | { phase: "done"; result: ImportResult }
  | { phase: "error"; message: string };

type SkippedState = { import: boolean; shortcut: boolean };

function CloudUploadIcon() {
  return (
    <svg
      aria-hidden
      className="h-8 w-8 text-fg-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <polyline points="16 16 12 12 8 16" />
      <line x1="12" y1="12" x2="12" y2="21" />
      <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckCircleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      style={{ width: size, height: size }}
      className="shrink-0 text-[color:var(--success-text)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MinusCircleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      style={{ width: size, height: size }}
      className="shrink-0 text-fg-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg
        aria-hidden
        className="h-[13px] w-[13px] shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden
      className="h-[13px] w-[13px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" />
    </svg>
  );
}

export type OnboardingOverlayProps = {
  workspaceName: string;
  onDone: () => void;
};

export function OnboardingOverlay({ workspaceName, onDone }: OnboardingOverlayProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [importState, setImportState] = useState<ImportState>({ phase: "idle" });
  const [drag, setDrag] = useState(false);
  const [skipped, setSkipped] = useState<SkippedState>({ import: false, shortcut: false });
  const [shortcutCopied, setShortcutCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const TOTAL = 4;

  const next = useCallback(() => {
    if (step < TOTAL - 1) {
      setStep((s) => s + 1);
    } else {
      markOnboardingDone();
      onDone();
    }
  }, [step, onDone]);

  const skip = useCallback(
    (key: keyof SkippedState) => {
      setSkipped((s) => ({ ...s, [key]: true }));
      setStep((s) => s + 1);
    },
    [],
  );

  const handleFile = useCallback((file: File) => {
    setImportState({ phase: "ready", file });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const copyShortcut = useCallback(() => {
    void navigator.clipboard.writeText(SHORTCUT_URL).catch(() => undefined);
    setShortcutCopied(true);
    setTimeout(() => { setShortcutCopied(false); }, 2000);
  }, []);

  const handleImportAndContinue = useCallback(async () => {
    if (importState.phase !== "ready") {
      next();
      return;
    }
    const { file } = importState;
    setImportState({ phase: "importing" });
    try {
      const fileType = detectFileType(file);
      const text = await readFileAsText(file);
      let result: ImportResult;
      if (fileType === "json") {
        result = await importJson(JSON.parse(text));
      } else {
        result = await importNetscapeHtml(text);
      }
      setImportState({ phase: "done", result });
      setTimeout(() => { next(); }, 800);
    } catch (err) {
      setImportState({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [importState, next]);

  const eyebrowFor = (s: number) => {
    if (s === 0) return t("onboarding.step1.eyebrow");
    if (s === 1) return t("onboarding.step2.eyebrow");
    if (s === 2) return t("onboarding.step3.eyebrow");
    return t("onboarding.step4.eyebrow");
  };

  const titleFor = (s: number) => {
    if (s === 0) return t("onboarding.step1.title");
    if (s === 1) return t("onboarding.step2.title");
    if (s === 2) return t("onboarding.step3.title");
    return t("onboarding.step4.title");
  };

  const ctaFor = (s: number) => {
    if (s === 0) return t("onboarding.step1.cta");
    if (s === 1) {
      if (importState.phase === "importing") return t("onboarding.step2.importing");
      return importState.phase === "ready"
        ? t("onboarding.step2.cta_with_file")
        : t("onboarding.step2.cta_no_file");
    }
    if (s === 2) return t("onboarding.step3.cta");
    return t("onboarding.step4.cta");
  };

  const handleCtaClick = () => {
    if (step === 1) {
      void handleImportAndContinue();
    } else {
      next();
    }
  };

  const importCount =
    importState.phase === "done" ? importState.result.successCount : 0;

  return (
    <div
      data-testid="onboarding-overlay"
      role="dialog"
      aria-label={t("onboarding.overlay.aria_label")}
      aria-modal="true"
      className="fixed inset-0 z-[200] flex items-center justify-center"
    >
      {/* Faint backdrop showing app shell */}
      <div className="absolute inset-0 bg-canvas/[0.92] backdrop-blur-[2px]" />

      <div className="relative flex w-full max-w-[540px] flex-col gap-sp-6 rounded-2xl border border-[color:var(--border-subtle)] bg-overlay p-sp-8 shadow-overlay mx-sp-4">
        {/* SlugBase mark */}
        <div className="flex justify-center">
          <svg
            aria-hidden
            className="h-9 w-9 text-accent-text"
            viewBox="0 0 32 32"
            fill="currentColor"
          >
            <rect width="32" height="32" rx="8" fill="currentColor" opacity="0.18" />
            <rect x="8" y="8" width="16" height="6" rx="2" />
            <rect x="8" y="18" width="16" height="6" rx="2" />
            <rect x="13" y="13.5" width="6" height="5" rx="1" />
          </svg>
        </div>

        {/* Dot progress */}
        <div data-testid="onboarding-progress-dots" className="flex items-center justify-center gap-sp-3">
          {Array.from({ length: TOTAL }, (_, i) => (
            <div
              key={i}
              className={[
                "h-[7px] rounded-full transition-all duration-[var(--dur-fast,170ms)]",
                i === step
                  ? "w-[20px] bg-accent"
                  : i < step
                    ? "w-[7px] bg-accent/40"
                    : "w-[7px] bg-[color:var(--border-subtle)]",
              ].join(" ")}
            />
          ))}
        </div>

        {/* Step card */}
        <div key={step} className="onb-step flex flex-col gap-sp-5">
          <div>
            <p className="mb-sp-2 font-mono text-[length:var(--text-small)] font-medium uppercase tracking-wider text-accent-text">
              {eyebrowFor(step)}
            </p>
            <h2 className="m-0 text-[length:var(--text-h2)] font-semibold leading-snug text-fg">
              {titleFor(step)}
            </h2>
          </div>

          {/* Step 1: Welcome + stats */}
          {step === 0 && (
            <div className="flex flex-col gap-sp-5">
              <p className="text-[length:var(--text-body-lg)] leading-relaxed text-fg-muted">
                {t("onboarding.step1.body")}
              </p>
              <div className="flex gap-sp-4 rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-5">
                {[
                  ["∞", t("onboarding.step1.stats.slugs")],
                  ["1", t("onboarding.step1.stats.workspace")],
                ].map(([n, label]) => (
                  <div
                    key={label}
                    className="flex flex-1 flex-col items-center gap-sp-2 text-center"
                  >
                    <span className="font-mono text-[22px] font-bold leading-none text-accent-text">
                      {n}
                    </span>
                    <span className="text-[length:var(--text-small)] text-fg-subtle">
                      {label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 2: Import */}
          {step === 1 && (
            <div className="flex flex-col gap-sp-5">
              <p className="text-[length:var(--text-body-lg)] leading-relaxed text-fg-muted">
                {t("onboarding.step2.body")}
              </p>
              <div
                data-testid="onboarding-drop-zone"
                className={`drop-zone${drag ? " drag" : ""}${importState.phase === "ready" || importState.phase === "done" ? " drag" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => { setDrag(false); }}
                onDrop={handleDrop}
                onClick={() => { fileInputRef.current?.click(); }}
              >
                <input
                  ref={fileInputRef}
                  data-testid="onboarding-file-input"
                  type="file"
                  accept=".html,.htm,.json"
                  className="sr-only"
                  onChange={handleFileChange}
                />
                {importState.phase === "ready" ? (
                  <div className="flex items-center gap-sp-3 text-[color:var(--success-text)]">
                    <CheckCircleIcon size={16} />
                    <span className="font-medium">{importState.file.name}</span>
                  </div>
                ) : importState.phase === "done" ? (
                  <div className="flex items-center gap-sp-3 text-[color:var(--success-text)]">
                    <CheckCircleIcon size={16} />
                    <span className="font-medium">
                      {t("onboarding.step2.import_success", { count: importCount })}
                    </span>
                  </div>
                ) : (
                  <>
                    <CloudUploadIcon />
                    <p className="m-0 text-[length:var(--text-body)]">
                      <strong>{t("onboarding.step2.dropzone_cta")}</strong>{" "}
                      {t("onboarding.step2.dropzone_or")}
                    </p>
                    <p className="m-0 text-[length:var(--text-small)] text-fg-subtle">
                      {t("onboarding.step2.dropzone_hint")}
                    </p>
                  </>
                )}
              </div>
              {importState.phase === "error" && (
                <p className="text-[length:var(--text-small)] text-[color:var(--danger-text)]">
                  {t("onboarding.step2.import_error")}
                </p>
              )}
            </div>
          )}

          {/* Step 3: Browser shortcut */}
          {step === 2 && (
            <div className="flex flex-col gap-sp-5">
              <p className="text-[length:var(--text-body-lg)] leading-relaxed text-fg-muted">
                {t("onboarding.step3.body")}
              </p>
              <div className="flex flex-col gap-sp-4 rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-5">
                {[
                  {
                    num: "1",
                    label: t("onboarding.step3.step1_label"),
                    sub: (
                      <span className="mt-sp-2 block rounded-sm border border-[color:var(--border-subtle)] bg-canvas px-sp-3 py-[5px] font-mono text-[length:var(--text-small)] text-fg-faint">
                        chrome://settings/searchEngines
                      </span>
                    ),
                  },
                  {
                    num: "2",
                    label: t("onboarding.step3.step2_label"),
                    sub: (
                      <div className="mt-sp-3 flex flex-col gap-sp-2">
                        <p className="m-0 text-[length:var(--text-small)] text-fg-subtle">
                          {t("onboarding.step3.step2_sub")}
                        </p>
                        {[
                          { field: t("onboarding.step3.field_name"), value: t("onboarding.step3.example_name"), copy: false },
                          { field: t("onboarding.step3.field_keyword"), value: t("onboarding.step3.example_keyword"), copy: false },
                          { field: t("onboarding.step3.field_url"), value: SHORTCUT_URL, copy: true },
                        ].map(({ field, value, copy }) => (
                          <div
                            key={field}
                            className="flex items-center gap-sp-3 rounded-sm border border-[color:var(--border-subtle)] bg-canvas px-sp-3 py-[5px]"
                          >
                            <span className="w-[90px] shrink-0 text-[length:var(--text-small)] text-fg-subtle">
                              {field}
                            </span>
                            <span className="flex-1 font-mono text-[length:var(--text-small)] text-fg">
                              {value}
                            </span>
                            {copy && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); copyShortcut(); }}
                                className="inline-flex shrink-0 items-center gap-[4px] rounded-sm border border-[color:var(--border-subtle)] bg-raised px-sp-2 py-[3px] text-[11px] text-fg-muted transition-colors hover:text-fg"
                              >
                                <CopyIcon copied={shortcutCopied} />
                                {shortcutCopied
                                  ? t("onboarding.step3.copied")
                                  : t("onboarding.step3.copy_action")}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ),
                  },
                  {
                    num: "3",
                    label: t("onboarding.step3.step3_label"),
                    sub: (
                      <p className="m-0 mt-sp-2 text-[length:var(--text-small)] text-fg-subtle">
                        {t("onboarding.step3.step3_sub")}
                      </p>
                    ),
                  },
                ].map(({ num, label, sub }) => (
                  <div key={num} className="flex gap-sp-4">
                    <span className="inline-grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-subtle font-mono text-[11px] font-semibold text-accent-text">
                      {num}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-[length:var(--text-body)] font-medium text-fg">
                        {label}
                      </p>
                      {sub}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 4: Summary */}
          {step === 3 && (
            <div className="flex flex-col gap-sp-4">
              <div className="flex items-start gap-sp-4 rounded-lg border border-[color:var(--border-subtle)] p-sp-4">
                <CheckCircleIcon size={18} />
                <span className="text-[length:var(--text-body)] text-fg-muted">
                  {t("onboarding.step4.workspace_done", { name: workspaceName })}
                </span>
              </div>
              <div className="flex items-start gap-sp-4 rounded-lg border border-[color:var(--border-subtle)] p-sp-4">
                {skipped.import ? <MinusCircleIcon size={18} /> : <CheckCircleIcon size={18} />}
                <span className="text-[length:var(--text-body)] text-fg-muted">
                  {skipped.import
                    ? t("onboarding.step4.import_skipped")
                    : t("onboarding.step4.import_done", { count: importCount })}
                </span>
              </div>
              <div className="flex items-start gap-sp-4 rounded-lg border border-[color:var(--border-subtle)] p-sp-4">
                {skipped.shortcut ? <MinusCircleIcon size={18} /> : <CheckCircleIcon size={18} />}
                <span className="text-[length:var(--text-body)] text-fg-muted">
                  {skipped.shortcut
                    ? t("onboarding.step4.shortcut_skipped")
                    : t("onboarding.step4.shortcut_done")}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-sp-5">
          <button
            type="button"
            data-testid="onboarding-step-cta"
            disabled={importState.phase === "importing"}
            onClick={handleCtaClick}
            className="inline-flex items-center gap-sp-2 rounded-md bg-accent px-sp-6 py-sp-3 text-[length:var(--text-body)] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ctaFor(step)}
          </button>
          {step === 1 && (
            <button
              type="button"
              data-testid="onboarding-skip-btn"
              onClick={() => { skip("import"); }}
              className="text-[length:var(--text-small)] text-fg-subtle transition-colors hover:text-fg"
            >
              {t("onboarding.step2.skip")}
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              data-testid="onboarding-skip-btn"
              onClick={() => { skip("shortcut"); }}
              className="text-[length:var(--text-small)] text-fg-subtle transition-colors hover:text-fg"
            >
              {t("onboarding.step3.skip")}
            </button>
          )}
        </div>

        {/* Step counter */}
        <p className="m-0 text-right text-[length:var(--text-micro)] text-fg-faint">
          {step + 1} / {TOTAL}
        </p>
      </div>
    </div>
  );
}

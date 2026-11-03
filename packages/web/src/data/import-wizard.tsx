import { Button, Progress, ProgressIndicator, ProgressLabel, ProgressTrack } from "@slugbase/ui";
import { CheckboxField, FileDrop, Wizard, useUnsavedForm } from "@slugbase/ui/patterns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery, ME_QUERY_KEY } from "../account/me.ts";
import { useUpdatePreferences } from "../account/use-update-preferences.ts";
import { newIdempotencyKey } from "../api/idempotency-key.ts";
import { BOOKMARKS_QUERY_KEY } from "../bookmarks/bookmarks.ts";
import { ENTITLEMENTS_QUERY_KEY } from "../entitlements/entitlements.ts";
import { FOLDERS_QUERY_KEY } from "../folders/folders.ts";
import { useFormat, type Format } from "../i18n/use-format.ts";
import { TAGS_QUERY_KEY } from "../tags/tags.ts";
import {
  IMPORT_ACCEPT,
  fileRefusalOf,
  importFailureOf,
  importFormatOf,
  sendImport,
  type FileRefusal,
  type ImportFailure,
  type ImportResult,
} from "./import-api.ts";
import { useFileRefusalMessage, useImportFailureMessage } from "./import-messages.ts";
import { ImportResultView } from "./import-result.tsx";

const STEP_COUNT = 3;
const FILE_STEP = 1;
const PREVIEW_STEP = 2;
const RUN_STEP = 3;

type Phase = "preview" | "import";

interface Failed {
  readonly failure: ImportFailure;
  readonly phase: Phase;
}

interface Row {
  readonly label: string;
  readonly value: number;
}

function CountList({ title, rows, format, busy }: { title: string; rows: readonly Row[]; format: Format; busy: boolean }): ReactElement {
  return (
    <div className="flex flex-col gap-1" aria-busy={busy}>
      <p className="font-medium text-sm">{title}</p>
      <dl className={busy ? "flex flex-col gap-1 opacity-64" : "flex flex-col gap-1"}>
        {rows.map((row) => (
          <div className="flex items-baseline justify-between gap-4 text-sm" key={row.label}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="tabular-nums">{format.number(row.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function skippedBecause(result: ImportResult, reason: ImportResult["skipped"][number]["reason"]): number {
  return result.skipped.filter((entry) => entry.reason === reason).length;
}

/**
 * The import of doc 03 section 11.5 as a wizard on the page: choose a file, preview what a dry run says the import
 * would do, run it. The request is synchronous and reports nothing while it runs, so its progress has no value.
 * Every refusal is told at the file field, with the way to ask again, and the file stays chosen.
 */
export function ImportWizard(): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const me = useQuery(meQuery(api));
  const markImportDone = useUpdatePreferences();
  const refusalMessage = useFileRefusalMessage();
  const failureMessage = useImportFailureMessage();

  const [step, setStep] = useState(FILE_STEP);
  const [file, setFile] = useState<File | null>(null);
  const [refusal, setRefusal] = useState<FileRefusal | null>(null);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [busy, setBusy] = useState<Phase | null>(null);

  const mounted = useRef(true);
  const previewRequest = useRef<AbortController | null>(null);
  const importing = useRef(false);
  // One key per run of the import, kept while the run is repeated after a failure, so a run that did reach the server is not done twice.
  const idempotencyKey = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previewRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (failed !== null) {
      fileInput.current?.focus();
    }
  }, [failed]);

  // The wizard holds a chosen file until the import has run, so leaving before then asks first.
  useUnsavedForm(file !== null && result === null);

  async function ask(target: File, skip: boolean): Promise<void> {
    const kind = importFormatOf(target);
    if (kind === undefined) {
      return;
    }
    previewRequest.current?.abort();
    const own = new AbortController();
    previewRequest.current = own;
    setBusy("preview");
    setFailed(null);
    try {
      const answer = await sendImport(api, { file: target, format: kind, skipDuplicates: skip, dryRun: true }, own.signal);
      if (!own.signal.aborted) {
        setPreview(answer);
        setStep(PREVIEW_STEP);
      }
    } catch (caught) {
      if (own.signal.aborted) {
        return;
      }
      const failure = importFailureOf(caught);
      if (failure !== undefined) {
        setFailed({ failure, phase: "preview" });
        setStep(FILE_STEP);
      }
    } finally {
      if (!own.signal.aborted) {
        setBusy(null);
      }
    }
  }

  async function run(): Promise<void> {
    if (importing.current || file === null) {
      return;
    }
    const kind = importFormatOf(file);
    if (kind === undefined) {
      return;
    }
    importing.current = true;
    idempotencyKey.current ??= newIdempotencyKey();
    setBusy("import");
    setFailed(null);
    markImportDone.reset();
    setStep(RUN_STEP);
    try {
      const answer = await sendImport(
        api,
        { file, format: kind, skipDuplicates, dryRun: false, idempotencyKey: idempotencyKey.current },
        // The import is not given up with the page: the member asked for it and the server finishes it either way.
        new AbortController().signal,
      );
      idempotencyKey.current = null;
      for (const queryKey of [BOOKMARKS_QUERY_KEY, FOLDERS_QUERY_KEY, TAGS_QUERY_KEY, ENTITLEMENTS_QUERY_KEY, ME_QUERY_KEY]) {
        void queryClient.invalidateQueries({ queryKey });
      }
      if (answer.created > 0) {
        // The import wrote, so the Getting started step is done. A failed save leaves the result on screen and says so there.
        markImportDone.mutate({ onboarding: { importDone: true } });
      }
      if (mounted.current) {
        setResult(answer);
      }
    } catch (caught) {
      const failure = importFailureOf(caught);
      if (mounted.current) {
        // An ended session is answered by the app as a whole and has no message here, but the run is over either way.
        if (failure !== undefined) {
          setFailed({ failure, phase: "import" });
        }
        setStep(FILE_STEP);
      }
    } finally {
      importing.current = false;
      if (mounted.current) {
        setBusy(null);
      }
    }
  }

  function choose(next: File): void {
    const turnedAway = fileRefusalOf(next);
    idempotencyKey.current = null;
    markImportDone.reset();
    setPreview(null);
    setResult(null);
    setFailed(null);
    setRefusal(turnedAway ?? null);
    setFile(turnedAway === undefined ? next : null);
  }

  function changeSkipDuplicates(next: boolean): void {
    setSkipDuplicates(next);
    // Another request, so another run: the server refuses a key that comes back with a different request.
    idempotencyKey.current = null;
    if (file !== null) {
      void ask(file, next);
    }
  }

  function startOver(): void {
    idempotencyKey.current = null;
    setStep(FILE_STEP);
    setFile(null);
    setRefusal(null);
    setSkipDuplicates(true);
    setPreview(null);
    setResult(null);
    setFailed(null);
    markImportDone.reset();
  }

  function retry(): void {
    if (failed?.phase === "import") {
      void run();
    } else if (file !== null) {
      void ask(file, skipDuplicates);
    }
  }

  function next(): void {
    if (step === FILE_STEP && file !== null) {
      void ask(file, skipDuplicates);
    } else if (step === PREVIEW_STEP) {
      void run();
    } else if (step === RUN_STEP && result !== null) {
      startOver();
    }
  }

  const account = me.data;
  const workspace = account?.memberships.find((membership) => membership.workspaceId === account.activeWorkspaceId)?.name;
  const fileError = refusal !== null ? refusalMessage(refusal) : failed !== null ? failureMessage(failed.failure) : undefined;

  let status = "";
  if (busy === "preview") {
    status = t("data.import.status.checking");
  } else if (busy === "import") {
    status = t("data.import.status.running");
  } else if (step === RUN_STEP && result !== null) {
    status = t("data.import.status.done", { created: result.created, skipped: result.skipped.length, failed: result.failed.length, slugs: result.slugsDropped });
  } else if (failed !== null) {
    status = failed.phase === "import" ? t("data.import.status.failed") : t("data.import.status.checkFailed");
  }

  const skippedAsDuplicate = preview === null ? 0 : skippedBecause(preview, "duplicate");
  const skippedForRoom = preview === null ? 0 : skippedBecause(preview, "bookmark_limit_reached");
  const running = step === RUN_STEP && result === null;
  const stepTitles = [t("data.import.step1.title"), t("data.import.step2.title"), running ? t("data.import.step3.title.running") : t("data.import.step3.title.done")];
  const stepDescriptions = [
    t("data.import.step1.description"),
    t("data.import.step2.description"),
    running ? t("data.import.step3.description.running") : t("data.import.step3.description.done"),
  ];
  let nextLabel = t("data.import.next.preview");
  if (step === PREVIEW_STEP) {
    nextLabel = t("data.import.next.import");
  } else if (step === RUN_STEP) {
    nextLabel = running ? t("data.import.next.importing") : t("data.import.next.another");
  }

  return (
    <>
      <p aria-live="polite" className="sr-only" role="status">
        {status}
      </p>
      <Wizard
        backLabel={t("data.import.back")}
        description={t("data.import.description")}
        headingLevel={2}
        nextDisabled={(step === FILE_STEP && file === null) || running}
        nextLabel={nextLabel}
        onBack={
          step === PREVIEW_STEP
            ? () => {
                setStep(FILE_STEP);
              }
            : undefined
        }
        onNext={next}
        pending={busy !== null}
        step={step}
        stepCount={STEP_COUNT}
        stepDescription={stepDescriptions[step - 1]}
        stepLabel={t("data.import.stepLabel", { step, count: STEP_COUNT })}
        stepTitle={stepTitles[step - 1]}
        title={t("data.import.title")}
      >
        {step === FILE_STEP ? (
          <FileDrop
            accept={IMPORT_ACCEPT}
            action={
              failed === null ? undefined : (
                <Button onClick={retry} size="sm" variant="outline">
                  {t("data.import.retry")}
                </Button>
              )
            }
            description={t("data.import.file.description")}
            disabled={busy !== null}
            dropLabel={t("data.import.file.drop")}
            error={fileError}
            fileName={file?.name}
            inputRef={fileInput}
            label={t("data.import.file.label")}
            onFile={choose}
          />
        ) : null}
        {step === PREVIEW_STEP && preview !== null ? (
          <>
            <p className="text-sm">{workspace === undefined ? t("data.import.preview.targetUnknown") : t("data.import.preview.target", { workspace })}</p>
            <CountList
              busy={busy === "preview"}
              format={format}
              rows={[
                { label: t("data.import.count.bookmarks"), value: preview.detected.bookmarks },
                { label: t("data.import.count.folders"), value: preview.detected.folders },
                { label: t("data.import.count.tags"), value: preview.detected.tags },
              ]}
              title={t("data.import.preview.file")}
            />
            <CheckboxField
              checked={skipDuplicates}
              label={t("data.import.skipDuplicates")}
              onCheckedChange={changeSkipDuplicates}
            />
            <CountList
              busy={busy === "preview"}
              format={format}
              rows={[
                { label: t("data.import.preview.created"), value: preview.created },
                { label: t("data.import.preview.foldersCreated"), value: preview.foldersCreated },
                { label: t("data.import.preview.tagsCreated"), value: preview.tagsCreated },
                { label: t("data.import.preview.skippedDuplicate"), value: skippedAsDuplicate },
                { label: t("data.import.preview.skippedLimit"), value: skippedForRoom },
                { label: t("data.import.preview.failed"), value: preview.failed.length },
                { label: t("data.import.preview.slugsDropped"), value: preview.slugsDropped },
              ]}
              title={t("data.import.preview.plan")}
            />
          </>
        ) : null}
        {running ? (
          <Progress value={null}>
            <ProgressLabel>{t("data.import.running")}</ProgressLabel>
            <ProgressTrack>
              <ProgressIndicator />
            </ProgressTrack>
          </Progress>
        ) : null}
        {step === RUN_STEP && result !== null ? <ImportResultView checklistNotUpdated={markImportDone.isError} result={result} /> : null}
      </Wizard>
    </>
  );
}

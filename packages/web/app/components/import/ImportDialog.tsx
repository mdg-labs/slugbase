import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogContent } from "@slugbase/ui";

import {
  type ImportResult,
  detectFileType,
  importJson,
  importNetscapeHtml,
  readFileAsText,
} from "../onboarding/import-api.js";

type ImportState =
  | { phase: "idle" }
  | { phase: "ready"; file: File }
  | { phase: "importing" }
  | { phase: "error" };

export type ImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (result: ImportResult) => void;
  /** When true, import is blocked (bookmark cap reached). */
  atCap?: boolean;
};

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
      <path
        d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckCircleIcon({ size = 16 }: { size?: number }) {
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

export function ImportDialog({
  open,
  onOpenChange,
  onSuccess,
  atCap = false,
}: ImportDialogProps) {
  const { t } = useTranslation();
  const [importState, setImportState] = useState<ImportState>({ phase: "idle" });
  const [drag, setDrag] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setImportState({ phase: "idle" });
      setDrag(false);
    }
  }, [open]);

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

  const handleImport = useCallback(async () => {
    if (importState.phase !== "ready") return;
    const { file } = importState;
    setImportState({ phase: "importing" });
    try {
      const fileType = detectFileType(file);
      const text = await readFileAsText(file);
      let result: ImportResult;
      if (fileType === "json") {
        result = await importJson(JSON.parse(text) as unknown);
      } else {
        result = await importNetscapeHtml(text);
      }
      onSuccess?.(result);
      onOpenChange(false);
    } catch {
      setImportState({ phase: "error" });
    }
  }, [importState, onOpenChange, onSuccess]);

  const canImport = importState.phase === "ready" && !atCap;
  const isImporting = importState.phase === "importing";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        testId="import-dialog"
        title={t("bookmarks.import.dialog_title")}
        description={t("bookmarks.import.dialog_description")}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-sp-5 overflow-y-auto px-sp-8 py-sp-6">
          {atCap ? (
            <p
              className="rounded-lg border border-[color:rgba(240,104,107,0.32)] bg-[color:var(--danger-subtle)] px-sp-5 py-sp-4 text-[length:var(--text-body)] text-fg-muted"
              data-testid="import-dialog-cap-blocked"
            >
              {t("bookmarks.import.cap_blocked")}
            </p>
          ) : (
            <div
              data-testid="import-dialog-drop-zone"
              className={`drop-zone${drag ? " drag" : ""}${importState.phase === "ready" ? " drag" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => {
                setDrag(false);
              }}
              onDrop={handleDrop}
              onClick={() => {
                fileInputRef.current?.click();
              }}
            >
              <input
                ref={fileInputRef}
                data-testid="import-dialog-file-input"
                type="file"
                accept=".html,.htm,.json"
                className="sr-only"
                onChange={handleFileChange}
              />
              {importState.phase === "ready" ? (
                <div className="flex items-center gap-sp-3 text-[color:var(--success-text)]">
                  <CheckCircleIcon />
                  <span className="font-medium">{importState.file.name}</span>
                </div>
              ) : (
                <>
                  <CloudUploadIcon />
                  <p className="m-0 text-[length:var(--text-body)]">
                    <strong>{t("bookmarks.import.dropzone_cta")}</strong>{" "}
                    {t("bookmarks.import.dropzone_or")}
                  </p>
                  <p className="m-0 text-[length:var(--text-small)] text-fg-subtle">
                    {t("bookmarks.import.dropzone_hint")}
                  </p>
                </>
              )}
            </div>
          )}
          {importState.phase === "error" ? (
            <p
              className="text-[length:var(--text-small)] text-[color:var(--danger-text)]"
              data-testid="import-dialog-error"
            >
              {t("bookmarks.import.error")}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-sp-4 border-t border-[color:var(--border-subtle)] px-sp-8 py-sp-5">
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t("bookmarks.import.cancel_action")}
          </Button>
          {!atCap ? (
            <Button
              variant="primary"
              type="button"
              data-testid="import-dialog-submit"
              disabled={!canImport || isImporting}
              onClick={() => {
                void handleImport();
              }}
            >
              {isImporting
                ? t("bookmarks.import.importing")
                : t("bookmarks.import.import_action")}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

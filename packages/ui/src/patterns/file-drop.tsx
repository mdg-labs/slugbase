import { UploadIcon } from "lucide-react";
import { useState, type DragEvent, type ReactElement, type ReactNode, type Ref } from "react";
import { Input } from "../components/ui/input.tsx";
import { cn } from "../lib/utils.ts";
import { FormField } from "./form-field.tsx";

export interface FileDropProps {
  label: ReactNode;
  /** Names the field as it is posted. */
  name?: string;
  /** Help shown under the field, for example the formats and the size it takes; the field is described by it. */
  description?: ReactNode;
  /** Why the file is refused. While it is set the field is invalid and described by this message. */
  error?: ReactNode;
  /** What the file picker offers, as the `accept` attribute of a file input: extensions and media types. It does not keep a dropped file out. */
  accept?: string;
  /** Called with the first file that is dropped or chosen. The field keeps no file itself: the page checks it and decides whether to take it. */
  onFile: (file: File) => void;
  /** The invitation in the drop zone, for example "Drop a file here, or choose one". */
  dropLabel: ReactNode;
  /** The name of the file the page holds, shown in the zone. */
  fileName?: ReactNode;
  /** The way to act on the error, for example a retry button. */
  action?: ReactNode;
  disabled?: boolean;
  /** The file input, for a page that moves focus to it. */
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

function holdsFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * A file input in a field with a zone to drop a file on (doc 03 `file-drop`). Choosing a file with the picker and
 * dropping one report the same way, so the keyboard reaches everything the pointer does.
 */
export function FileDrop({ label, name, description, error, accept, onFile, dropLabel, fileName, action, disabled = false, inputRef, className }: FileDropProps): ReactElement {
  const [dragging, setDragging] = useState(false);
  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <FormField className="w-full" description={description} error={error} label={label} name={name}>
        <div
          className={cn(
            "flex flex-col items-center gap-3 rounded-lg border border-input border-dashed p-4 text-center transition-colors",
            dragging && "border-ring bg-accent",
            disabled && "opacity-64",
          )}
          data-dragging={dragging ? "true" : undefined}
          data-slot="file-drop-zone"
          onDragEnter={(event) => {
            if (!disabled && holdsFiles(event)) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDragOver={(event) => {
            if (!disabled && holdsFiles(event)) {
              event.preventDefault();
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const [file] = Array.from(event.dataTransfer.files);
            if (!disabled && file !== undefined) {
              onFile(file);
            }
          }}
        >
          <UploadIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">{dropLabel}</p>
          <Input
            accept={accept}
            disabled={disabled}
            onChange={(event) => {
              const [file] = Array.from(event.target.files ?? []);
              // Cleared so that choosing the same file again, after the page refused it or changed it, is a change.
              event.target.value = "";
              if (file !== undefined) {
                onFile(file);
              }
            }}
            ref={inputRef}
            type="file"
          />
          {fileName === undefined ? null : (
            <p className="break-all font-medium text-sm" data-slot="file-drop-name">
              {fileName}
            </p>
          )}
        </div>
      </FormField>
      {action}
    </div>
  );
}

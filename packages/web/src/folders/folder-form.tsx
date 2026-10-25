import { Button, Input } from "@slugbase/ui";
import { Banner, FormField, FormOverlay, Picker, SegmentedChoice, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { inPlaceRefusals } from "../shell/mutation-error-toasts.tsx";
import { useFolderIconLabels } from "./folder-icon-labels.ts";
import { FolderGlyph, folderBackgroundClass, folderIconOf } from "./folder-glyph.tsx";
import {
  FOLDERS_QUERY_KEY,
  FOLDER_COLOR_MAX,
  FOLDER_COLOR_MIN,
  FOLDER_DEFAULT_COLOR,
  FOLDER_DEFAULT_ICON,
  FOLDER_ICONS,
  FOLDER_NAME_MAX_LENGTH,
  createFolder,
  folderFailureOf,
  updateFolder,
  type Folder,
  type FolderFailure,
  type UpdateFolderRequest,
} from "./folders.ts";

const SECONDS_PER_MINUTE = 60;

// The refusals `folderFailureOf` tells in the form, for which the shared error toast stays quiet; any other failure still raises it.
const SHOWN_IN_THE_FORM = inPlaceRefusals([
  { status: 409, code: "name_taken" },
  { status: 422 },
  { status: 412, code: "precondition_failed" },
  { status: 404, code: "not_found" },
  { status: 429, code: "rate_limited" },
]);

const COLORS = Array.from({ length: FOLDER_COLOR_MAX - FOLDER_COLOR_MIN + 1 }, (_, index) => FOLDER_COLOR_MIN + index);

/** What the overlay is for: a new folder, or a change to an existing one by its name or by its icon and colour. */
export type FolderFormIntent = "create" | "rename" | "style";

export interface FolderFormProps {
  readonly intent: FolderFormIntent;
  /** The folder to change, as listed; none for a new one. */
  readonly folder?: Folder | undefined;
  readonly onClose: () => void;
}

interface Request {
  readonly folder: Folder | undefined;
  readonly name: string;
  readonly icon: string;
  readonly color: number;
}

function useColorNames(): Readonly<Record<number, string>> {
  const { t } = useTranslation();
  return {
    1: t("folders.color.1"),
    2: t("folders.color.2"),
    3: t("folders.color.3"),
    4: t("folders.color.4"),
    5: t("folders.color.5"),
    6: t("folders.color.6"),
    7: t("folders.color.7"),
    8: t("folders.color.8"),
  };
}

function isIcon(value: string): value is (typeof FOLDER_ICONS)[number] {
  return (FOLDER_ICONS as readonly string[]).includes(value);
}

/**
 * The form that creates a folder and, with the same fields, renames it or changes its icon and colour (doc 03 section 6,
 * `form-overlay`): the name, the icon in a `picker` over the curated set and the colour as one of the eight folder
 * tokens. A name the member already uses is shown at the name field; a change is sent against the version the list holds,
 * so a folder changed elsewhere is refused instead of overwritten. The overlay stays open on a failure.
 */
export function FolderForm({ intent, folder, onClose }: FolderFormProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const iconLabels = useFolderIconLabels();
  const colorNames = useColorNames();
  const [name, setName] = useState(folder?.name ?? "");
  const [icon, setIcon] = useState(folder?.icon ?? FOLDER_DEFAULT_ICON);
  const [color, setColor] = useState(folder?.color ?? FOLDER_DEFAULT_COLOR);
  const [nameRequired, setNameRequired] = useState(false);
  const [failure, setFailure] = useState<FolderFailure | undefined>(undefined);

  const save = useMutation({
    mutationKey: ["folders", "save"],
    meta: SHOWN_IN_THE_FORM,
    mutationFn: ({ folder: target, name: nextName, icon: nextIcon, color: nextColor }: Request): Promise<Folder> => {
      if (target === undefined) {
        return createFolder(api, { name: nextName, icon: isIcon(nextIcon) ? nextIcon : FOLDER_DEFAULT_ICON, color: nextColor });
      }
      const changes: UpdateFolderRequest = {
        ...(nextName === target.name ? {} : { name: nextName }),
        ...(nextIcon === target.icon || !isIcon(nextIcon) ? {} : { icon: nextIcon }),
        ...(nextColor === target.color ? {} : { color: nextColor }),
      };
      return updateFolder(api, target.id, target.version, changes);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
      feedbackToast.success(folder === undefined ? t("folders.form.saved.created") : t("folders.form.saved.updated"));
      onClose();
    },
    onError: (error) => {
      const next = folderFailureOf(error);
      setFailure(next);
      // A folder changed or removed elsewhere is out of date in the list too.
      if (next?.kind === "changedElsewhere" || next?.kind === "notFound") {
        void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
      }
    },
  });

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (save.isPending) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameRequired(true);
      return;
    }
    setFailure(undefined);
    save.mutate({ folder, name: trimmed, icon, color });
  }

  function failureMessage(value: FolderFailure): string {
    switch (value.kind) {
      case "nameTaken":
        return t("folders.form.name.error.taken");
      case "invalidName":
        return t("folders.form.name.error.invalid", { max: FOLDER_NAME_MAX_LENGTH });
      case "changedElsewhere":
        return t("folders.form.error.changedElsewhere");
      case "notFound":
        return t("folders.form.error.notFound");
      case "unavailable":
        return t("folders.form.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("reauth.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("reauth.error.rateLimited.seconds", { count: value.seconds })
          : t("reauth.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  }

  const nameFailure = failure?.kind === "nameTaken" || failure?.kind === "invalidName";
  const iconOptions = FOLDER_ICONS.map((value) => {
    const Icon = folderIconOf(value);
    return { value, label: iconLabels[value], icon: <Icon className="size-4" /> };
  });
  const colorOptions = COLORS.map((value) => ({
    value: String(value),
    label: colorNames[value] ?? String(value),
    icon: <span aria-hidden="true" className={`size-4 rounded-full ${folderBackgroundClass(value)}`} />,
  }));
  const title = intent === "create" ? t("folders.form.title.create") : intent === "rename" ? t("folders.form.title.rename") : t("folders.form.title.style");

  return (
    <FormOverlay
      closeLabel={t("folders.form.close")}
      description={t("folders.form.description")}
      onOpenChange={(open) => {
        if (!open && !save.isPending) {
          onClose();
        }
      }}
      open
      title={title}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {failure === undefined || nameFailure ? null : <Banner title={failureMessage(failure)} variant="error" />}
        <FormField
          error={nameFailure ? failureMessage(failure) : nameRequired ? t("folders.form.name.error.required") : undefined}
          label={t("folders.form.name.label")}
          name="name"
        >
          <Input
            autoComplete="off"
            disabled={save.isPending}
            maxLength={FOLDER_NAME_MAX_LENGTH}
            onChange={(event) => {
              setName(event.target.value);
              setNameRequired(false);
              if (nameFailure) {
                setFailure(undefined);
              }
            }}
            value={name}
          />
        </FormField>
        <Picker
          disabled={save.isPending}
          emptyLabel={t("folders.form.icon.empty")}
          label={t("folders.form.icon.label")}
          onValueChange={setIcon}
          options={iconOptions}
          placeholder={t("folders.form.icon.placeholder")}
          value={icon}
        />
        <SegmentedChoice
          disabled={save.isPending}
          iconOnly
          label={t("folders.form.color.label")}
          name="color"
          onValueChange={(value) => {
            setColor(Number(value));
          }}
          options={colorOptions}
          value={String(color)}
        />
        <div className="flex items-center gap-3" data-slot="folder-preview">
          <FolderGlyph color={color} icon={icon} />
          <span className="min-w-0 truncate text-sm">{name.trim() === "" ? t("folders.form.preview") : name.trim()}</span>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button disabled={save.isPending} onClick={onClose} type="button" variant="outline">
            {t("folders.form.cancel")}
          </Button>
          <Button loading={save.isPending} type="submit">
            {folder === undefined ? t("folders.form.submit.create") : t("folders.form.submit.update")}
          </Button>
        </div>
      </form>
    </FormOverlay>
  );
}

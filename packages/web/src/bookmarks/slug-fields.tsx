import { CopyValue, FormField, SettingSwitch, SlugInput, feedbackToast } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "../config/config-context.tsx";
import { BOOKMARK_SLUG_MAX_LENGTH, isValidSlug, slugAvailabilityQuery } from "./bookmarks.ts";

/** How long the slug is left alone before it is looked up, so a slug being typed is asked about once. */
export const SLUG_LOOKUP_DELAY_MS = 300;

export interface SlugFieldsProps {
  /** The slug as it is held, trimmed and lower-cased; empty for none. */
  slug: string;
  forwarding: boolean;
  /** The bookmark being changed, whose own slug is free to keep; none for a new one. */
  bookmarkId?: string | undefined;
  /** Why the API refused the slug, shown at the field until the slug changes. */
  problem?: string | undefined;
  disabled: boolean;
  onSlugChange: (slug: string) => void;
  onForwardingChange: (forwarding: boolean) => void;
}

function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, SLUG_LOOKUP_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [value]);
  return settled;
}

/**
 * The slug and forwarding fields of the bookmark modal (doc 03 section 4, fields 3 and 4; doc 02 section 6.1). The slug is held to
 * the grammar as it is typed. Once it has stood still for a moment, and only when it is in the grammar, the API is asked
 * whether it is free: the answer, and the number of other bookmarks that have it, is told under the field, and a lookup that is
 * running or has failed says so without holding the save back. A valid slug shows the address it makes with a copy action.
 * Forwarding needs a slug, so the switch is off and disabled without one, and turns on when one is entered.
 */
export function SlugFields({ slug, forwarding, bookmarkId, problem, disabled, onSlugChange, onForwardingChange }: SlugFieldsProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { origin } = useConfig();
  const settled = useSettled(slug);
  const valid = slug !== "" && isValidSlug(slug);
  const lookup = useQuery(slugAvailabilityQuery(router.options.context.api, valid && settled === slug ? slug : undefined, bookmarkId));
  const answered = valid && settled === slug && lookup.isSuccess ? lookup.data : undefined;
  const looking = valid && (settled !== slug || lookup.isFetching);
  const unchecked = valid && settled === slug && lookup.isError;

  let error: string | undefined;
  if ((slug !== "" && !valid) || answered?.status === "invalid") {
    error = t("bookmarks.modal.slug.error.invalid", { max: BOOKMARK_SLUG_MAX_LENGTH });
  } else if (problem !== undefined) {
    error = problem;
  } else if (answered?.status === "taken_by_me") {
    error = t("bookmarks.modal.slug.error.taken");
  }

  let note: string | undefined;
  if (error === undefined && answered?.status === "available") {
    note =
      answered.othersUseCount > 0
        ? t("bookmarks.modal.slug.othersUse", { count: answered.othersUseCount })
        : t("bookmarks.modal.slug.available");
  } else if (error === undefined && unchecked) {
    note = t("bookmarks.modal.slug.unchecked");
  }

  const address = `${origin}/go/${slug}`;
  return (
    <>
      <FormField description={note} error={error} label={t("bookmarks.modal.slug.label")} name="slug">
        <SlugInput
          disabled={disabled}
          onValueChange={onSlugChange}
          pending={looking}
          pendingLabel={t("bookmarks.modal.slug.checking")}
          placeholder={t("bookmarks.modal.slug.placeholder")}
          value={slug}
        />
      </FormField>
      {valid && answered?.status !== "taken_by_me" ? (
        <CopyValue
          copiedLabel={t("bookmarks.modal.slug.address.copied")}
          copyLabel={t("bookmarks.modal.slug.address.copy")}
          label={t("bookmarks.modal.slug.address.label")}
          onCopied={() => {
            feedbackToast.success(t("bookmarks.modal.slug.address.toast"));
          }}
          value={address}
        />
      ) : null}
      <SettingSwitch
        checked={forwarding}
        description={slug === "" ? t("bookmarks.modal.forwarding.needsSlug") : t("bookmarks.modal.forwarding.description")}
        disabled={disabled || slug === ""}
        label={t("bookmarks.modal.forwarding.label")}
        name="forwarding"
        onCheckedChange={onForwardingChange}
      />
    </>
  );
}

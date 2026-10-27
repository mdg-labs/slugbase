import { BOOKMARK_SLUG_PATTERN } from "@slugbase/contracts";
import { ArrowLeftRightIcon, CompassIcon, feedbackToast, PlusIcon, SlugChip, type CommandPaletteIntent, type CommandPaletteItem, type CommandPaletteSection } from "@slugbase/ui/patterns";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient } from "../api/client.ts";
import { useHowShared } from "../go/candidates-view.tsx";
import { resolveSlug, suggestQuery, type GoCandidate, type GoResolution, type GoSuggestion, type GoWorkspace } from "../go/go.ts";
import { useGoChoose } from "../go/use-go-choose.ts";
import { useSwitchFailureMessage, useWorkspaceSwitch } from "../shell/workspaces.ts";
import { PALETTE_SEARCH_DELAY_MS, useDebouncedValue } from "./palette-query.ts";

export interface PaletteGoOptions {
  readonly api: ApiClient;
  /** What the query asks to go to; undefined while the palette is in another mode. */
  readonly slug: string | undefined;
  /** Closes the palette, once the member has been sent to the destination. */
  readonly close: () => void;
  /** Whether the member can save a bookmark, which the not-found hint offers with the slug filled in. */
  readonly canSaveBookmarks: boolean;
  readonly createWithSlug: (slug: string) => void;
  /** The name of the workspace the slug is looked up in. */
  readonly workspaceName: string | undefined;
}

export interface PaletteGo {
  readonly sections: readonly CommandPaletteSection[];
  /** Drops the answer of an earlier Enter; called as the query changes and when the palette closes. */
  readonly reset: () => void;
}

/**
 * The palette's `go` mode (doc 02 section 9.2): the slugs that start with what was typed, and Enter resolving the slug exactly as the
 * `/go` page does (doc 02 section 6.2). A slug with one answer is chosen at once, which counts the use and answers the destination the
 * palette leaves for; several candidates are listed in place with "Always use this"; none shows the not-found hint with the member's
 * other workspaces. The destination is only ever the answer of `POST /go/choose`.
 */
export function usePaletteGo({ api, slug, close, canSaveBookmarks, createWithSlug, workspaceName }: PaletteGoOptions): PaletteGo {
  const { t } = useTranslation();
  const howShared = useHowShared();
  const choose = useGoChoose();
  const { switchTo } = useWorkspaceSwitch();
  const switchFailureMessage = useSwitchFailureMessage();
  const [remember, setRemember] = useState(false);
  const resolve = useMutation({ mutationFn: (target: string): Promise<GoResolution> => resolveSlug(api, target) });

  const typed = slug ?? "";
  const settled = useDebouncedValue(typed, PALETTE_SEARCH_DELAY_MS);
  // The API suggests nothing for a prefix outside the slug grammar; asking would only wait for an empty answer.
  const suggestible = BOOKMARK_SLUG_PATTERN.test(settled);
  const suggestions = useQuery({ ...suggestQuery(api, settled), enabled: slug !== undefined && suggestible });

  const run = (target: string): void => {
    choose.reset();
    setRemember(false);
    resolve.mutate(target, {
      onSuccess: (answer) => {
        if (answer.result === "single" || answer.result === "preferred") {
          choose.mutate({ slug: target, bookmarkId: answer.bookmark.id, remember: false }, { onSuccess: close });
        }
      },
    });
  };

  const reset = (): void => {
    resolve.reset();
    choose.reset();
    setRemember(false);
  };

  const target = resolve.variables ?? typed;
  const answer = resolve.data;
  const idle = resolve.isIdle;

  const goRow = (target_: string, known: GoSuggestion | undefined): CommandPaletteItem => ({
    id: `go:${target_}`,
    label: t("palette.go.open", { slug: target_ }),
    icon: <CompassIcon aria-hidden="true" />,
    ...(known === undefined ? {} : { detail: suggestionDetail(known, false) }),
    onSelect: (intent) => {
      if (intent !== "edit") {
        run(target_);
      }
    },
  });

  const suggestionDetail = (suggestion: GoSuggestion, withSlug: boolean): ReactElement => (
    <span className="flex min-w-0 items-center gap-2">
      {withSlug ? <SlugChip slug={suggestion.slug} /> : null}
      <span className="truncate" translate="no">
        {withSlug ? suggestion.host : `${suggestion.title} · ${suggestion.host}`}
      </span>
      {suggestion.owner === null && suggestion.sharedVia === null ? null : <span className="truncate">{howShared(suggestion)}</span>}
    </span>
  );

  const suggestionSection = (): CommandPaletteSection => {
    const title = t("palette.go.suggestions");
    if (typed !== settled || (suggestible && suggestions.isPending)) {
      return { id: "suggestions", title, state: "loading", loadingLabel: t("palette.go.suggestionsLoading") };
    }
    if (suggestible && suggestions.isError) {
      return { id: "suggestions", title, state: "error", error: { message: t("palette.go.suggestionsFailed"), retryLabel: t("palette.retry"), onRetry: () => void suggestions.refetch() } };
    }
    const others = (suggestible ? (suggestions.data ?? []) : []).filter((suggestion) => suggestion.slug !== typed);
    return {
      id: "suggestions",
      title,
      prefiltered: true,
      items: others.map((suggestion) => ({
        id: suggestion.bookmarkId,
        label: suggestion.title,
        icon: <CompassIcon aria-hidden="true" />,
        detail: suggestionDetail(suggestion, true),
        onSelect: (intent: CommandPaletteIntent) => {
          if (intent !== "edit") {
            run(suggestion.slug);
          }
        },
      })),
    };
  };

  const resolvedSections = (asked: string, resolution: GoResolution | undefined): CommandPaletteSection[] => {
    const oneAnswer = resolution?.result === "single" || resolution?.result === "preferred";
    if (resolve.isPending || choose.isPending || choose.isSuccess || (oneAnswer && choose.isIdle)) {
      return [{ id: "go", state: "loading", loadingLabel: t("palette.go.resolving", { slug: asked }) }];
    }
    if (resolve.isError || choose.isError || resolution === undefined) {
      const message = choose.isError ? t("go.choose.failed.title") : t("go.loadFailed.title");
      return [
        {
          id: "go",
          state: "error",
          error: {
            message,
            retryLabel: t("palette.retry"),
            onRetry: () => {
              run(asked);
            },
          },
        },
      ];
    }
    if (resolution.result === "multiple") {
      return candidateSections(asked, resolution.candidates);
    }
    return resolution.result === "none" ? notFoundSections(asked, resolution.otherWorkspaces) : [];
  };

  const candidateSections = (asked: string, candidates: readonly GoCandidate[]): CommandPaletteSection[] => [
    {
      id: "candidates",
      title: t("go.choose.title", { slug: asked, count: candidates.length }),
      prefiltered: true,
      items: [
        ...candidates.map((candidate): CommandPaletteItem => ({
          id: candidate.id,
          label: candidate.title,
          icon: <CompassIcon aria-hidden="true" />,
          detail: (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate" translate="no">
                {candidate.host}
              </span>
              <span className="truncate">{howShared(candidate)}</span>
            </span>
          ),
          onSelect: (intent) => {
            if (intent !== "edit") {
              choose.mutate({ slug: asked, bookmarkId: candidate.id, remember }, { onSuccess: close });
            }
          },
        })),
        {
          id: "always",
          label: t("go.choose.always", { slug: asked }),
          checked: remember,
          onSelect: () => {
            setRemember(!remember);
          },
        },
      ],
    },
  ];

  const notFoundSections = (asked: string, others: readonly GoWorkspace[]): CommandPaletteSection[] => {
    const items: CommandPaletteItem[] = [];
    if (canSaveBookmarks && BOOKMARK_SLUG_PATTERN.test(asked)) {
      items.push({
        id: "create",
        label: t("go.notFound.create"),
        icon: <PlusIcon aria-hidden="true" />,
        onSelect: () => {
          close();
          createWithSlug(asked);
        },
      });
    }
    for (const workspace of others) {
      items.push({
        id: `switch:${workspace.id}`,
        label: t("go.notFound.switch", { workspace: workspace.name }),
        icon: <ArrowLeftRightIcon aria-hidden="true" />,
        onSelect: () => {
          void switchTo(workspace.id).then((outcome) => {
            if (outcome.status === "switched") {
              run(asked);
            } else if (outcome.status === "failed") {
              if (outcome.failure !== undefined) {
                feedbackToast.error(t("workspaces.switch.failed.title"), switchFailureMessage(outcome.failure));
              }
              if (outcome.failure === "notAMember") {
                run(asked);
              }
            }
          });
        },
      });
    }
    return [
      {
        id: "not-found",
        state: "empty",
        notice: {
          title: t("go.notFound.title", { slug: asked, workspace: workspaceName ?? t("go.notFound.thisWorkspace") }),
          description: t("go.notFound.description"),
          icon: <CompassIcon aria-hidden="true" />,
        },
      },
      { id: "actions", prefiltered: true, items },
    ];
  };

  const sectionsNow = (): CommandPaletteSection[] => {
    if (slug === undefined) {
      return [];
    }
    if (!idle) {
      return resolvedSections(target, answer);
    }
    if (typed === "") {
      return [{ id: "go", state: "empty", notice: { title: t("palette.go.empty.title"), description: t("palette.go.empty.description"), icon: <CompassIcon aria-hidden="true" /> } }];
    }
    return [{ id: "go", prefiltered: true, items: [goRow(typed, suggestions.data?.find((suggestion) => suggestion.slug === typed))] }, suggestionSection()];
  };

  return { sections: sectionsNow(), reset };
}

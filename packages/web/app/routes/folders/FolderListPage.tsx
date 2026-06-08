import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Form, useLoaderData, useNavigate, useNavigation, useRevalidator, useSearchParams } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Button, EmptyState } from "@slugbase/ui";
import { ScopeFilter } from "../../components/sharing/ScopeFilter.js";
import { ScopeIcon } from "../../components/sharing/ScopeIcon.js";
import { SharingLabel } from "../../components/sharing/SharingLabel.js";
import { ShareDialog } from "../../components/sharing/ShareDialog.js";
import type { SharingScope } from "../../components/sharing/sharing.types.js";
import { resolveResourceSharingScope } from "../../components/sharing/sharing.utils.js";
import { useWorkspaceEntitlements } from "../../components/sharing/use-workspace-entitlements.js";
import { useAppToast } from "../../components/feedback/AppToastProvider.js";
import { formatRelativeTime } from "../../components/dashboard/dashboard.utils.js";
import {
  type FolderListData,
  type FolderListItem,
} from "./folders-loader.js";
import { FolderListSkeleton } from "./FolderListSkeleton.js";
import { createFolder, renameFolder, deleteFolder } from "./folders-api.js";

const SORTS = ["name-asc", "created-desc", "count-desc"] as const;
type FolderSort = (typeof SORTS)[number];

function isFolderSort(value: string): value is FolderSort {
  return (SORTS as readonly string[]).includes(value);
}

function FolderColorDot({ color }: { color: string | null }) {
  return (
    <span
      className="inline-block shrink-0 rounded"
      style={{
        width: 10,
        height: 10,
        background: color ?? "var(--fg-faint)",
      }}
      aria-hidden="true"
    />
  );
}

interface FolderRowProps {
  folder: FolderListItem;
  currentUserId: string | null;
  canShare: boolean;
  isRenaming: boolean;
  isDelConfirm: boolean;
  renameVal: string;
  ownerName: string | null;
  onRenameStart: (folder: FolderListItem) => void;
  onRenameChange: (val: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelConfirm: (folder: FolderListItem) => void;
  onDelCancel: () => void;
  onDelCommit: (folder: FolderListItem) => void;
  onShareSettings: (folder: FolderListItem) => void;
}

function FolderRow({
  folder,
  currentUserId,
  canShare,
  isRenaming,
  isDelConfirm,
  renameVal,
  ownerName,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelConfirm,
  onDelCancel,
  onDelCommit,
  onShareSettings,
}: FolderRowProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const renameInputRef = useRef<HTMLInputElement>(null);
  const itemScope = resolveResourceSharingScope(
    folder.userId,
    currentUserId ?? "",
    folder.shareGrantCount,
  );
  const relativeTime = formatRelativeTime(folder.updatedAt);

  useEffect(() => {
    if (isRenaming) { renameInputRef.current?.focus(); renameInputRef.current?.select(); }
  }, [isRenaming]);

  return (
    <div>
      <div
        className={[
          "group flex items-center gap-sp-4 rounded-lg border border-transparent px-sp-5 py-sp-4 transition-colors",
          "hover:border-[color:var(--border-subtle)] hover:bg-[color:var(--raised-2)]",
        ].join(" ")}
        data-testid={`folder-list-item-${folder.id}`}
        data-scope={itemScope}
        onDoubleClick={() => { void navigate(`/bookmarks?folderId=${folder.id}`); }}
      >
        <FolderColorDot color={folder.color} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-sp-3">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameVal}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { onRenameChange(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { onRenameCommit(); }
                  if (e.key === "Escape") { onRenameCancel(); }
                }}
                onBlur={onRenameCommit}
                onClick={(e) => { e.stopPropagation(); }}
                className="w-48 rounded border border-[color:var(--accent)] bg-[color:var(--base)] px-sp-3 py-sp-1 text-fg outline-none"
                style={{ fontSize: "var(--text-body)" }}
                maxLength={200}
              />
            ) : (
              <p className="truncate font-medium text-fg">{folder.name}</p>
            )}
            <ScopeIcon scope={itemScope} />
            {ownerName && (
              <span
                className="text-fg-subtle"
                style={{ fontSize: "var(--text-small)" }}
              >
                {t("folders.list.owner_label", { name: ownerName })}
              </span>
            )}
            {canShare && (
              <SharingLabel
                scope={itemScope}
                shareGrantCount={folder.shareGrantCount}
              />
            )}
          </div>
          <p
            className="mt-sp-1 text-fg-subtle"
            style={{ fontSize: "var(--text-small)", fontFamily: "var(--font-mono)" }}
          >
            {t("folders.list.bookmark_count", { count: folder.bookmarkCount })}
          </p>
        </div>

        {relativeTime && (
          <span
            className="hidden shrink-0 text-fg-subtle sm:block"
            style={{ fontSize: "var(--text-small)", fontFamily: "var(--font-mono)" }}
          >
            {relativeTime}
          </span>
        )}

        <div className="flex shrink-0 items-center gap-sp-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            title={t("folders.list.action_open")}
            aria-label={t("folders.list.action_open")}
            className="inline-flex items-center justify-center rounded p-sp-2 text-fg-muted transition-colors hover:bg-[color:var(--overlay)] hover:text-fg"
            onClick={() => { void navigate(`/bookmarks?folderId=${folder.id}`); }}
          >
            <ExternalLinkIcon size={15} />
          </button>
          <button
            type="button"
            title={t("folders.list.action_rename")}
            aria-label={t("folders.list.action_rename")}
            className="inline-flex items-center justify-center rounded p-sp-2 text-fg-muted transition-colors hover:bg-[color:var(--overlay)] hover:text-fg"
            onClick={() => { onRenameStart(folder); }}
          >
            <PencilIcon size={15} />
          </button>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                title={t("folders.list.action_more")}
                aria-label={t("folders.list.action_more")}
                className="inline-flex items-center justify-center rounded p-sp-2 text-fg-muted transition-colors hover:bg-[color:var(--overlay)] hover:text-fg"
              >
                <MoreHorizontalIcon size={15} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="z-50 min-w-[180px] overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--overlay)] p-sp-2 shadow-lg"
                align="end"
                sideOffset={4}
              >
                <DropdownMenu.Item
                  className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-fg outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                  style={{ fontSize: "var(--text-body)" }}
                  onSelect={() => { void navigate(`/bookmarks?folderId=${folder.id}`); }}
                >
                  <ExternalLinkIcon size={14} className="shrink-0 text-fg-muted" />
                  {t("folders.list.menu_open_bookmarks")}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-fg outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                  style={{ fontSize: "var(--text-body)" }}
                  onSelect={() => { onRenameStart(folder); }}
                >
                  <PencilIcon size={14} className="shrink-0 text-fg-muted" />
                  {t("folders.list.menu_rename")}
                </DropdownMenu.Item>
                {canShare && (
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-fg outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                    style={{ fontSize: "var(--text-body)" }}
                    onSelect={() => { onShareSettings(folder); }}
                  >
                    <SettingsIcon size={14} className="shrink-0 text-fg-muted" />
                    {t("folders.list.menu_share_settings")}
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Separator className="my-sp-2 border-t border-[color:var(--border)]" />
                <DropdownMenu.Item
                  className="flex cursor-pointer items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-[color:var(--danger-text)] outline-none transition-colors hover:bg-[color:var(--raised-2)] focus:bg-[color:var(--raised-2)]"
                  style={{ fontSize: "var(--text-body)" }}
                  onSelect={() => { onDelConfirm(folder); }}
                >
                  <Trash2Icon size={14} className="shrink-0" />
                  {t("folders.list.menu_delete")}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      {isDelConfirm && (
        <div className="mx-sp-2 mb-sp-2 flex flex-wrap items-center gap-sp-3 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--raised)] px-sp-5 py-sp-3">
          <AlertTriangleIcon size={14} className="shrink-0 text-[color:var(--warning-text)]" />
          <span className="flex-1 text-fg-muted" style={{ fontSize: "var(--text-small)" }}>
            {t("folders.list.delete_inline_body", { name: folder.name })}
          </span>
          <div className="flex gap-sp-2">
            <Button variant="danger" size="sm" type="button" onClick={() => { onDelCommit(folder); }}>
              {t("folders.list.delete_confirm")}
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={onDelCancel}>
              {t("folders.list.delete_cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface NewFolderDialogProps {
  onClose: () => void;
  onSaved: () => void;
}

function NewFolderDialog({ onClose, onSaved }: NewFolderDialogProps) {
  const { t } = useTranslation();
  const { showToast, showError } = useAppToast();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await createFolder(trimmed);
      showToast("folders.list.toast_created");
      onSaved();
    } catch {
      showError(t("folders.list.error_create"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[3px]"
      role="dialog"
      aria-modal="true"
      aria-label={t("folders.list.new_dialog_label")}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-xl border border-[color:var(--border)] bg-[color:var(--overlay)] p-sp-6 shadow-xl">
        <h2
          className="mb-sp-5 font-semibold text-fg"
          style={{ fontSize: "var(--text-h3)" }}
        >
          {t("folders.list.new_title")}
        </h2>
        <form onSubmit={(e) => { void handleSubmit(e); }}>
          <label
            htmlFor="folder-new-input"
            className="mb-sp-2 block text-fg-muted"
            style={{ fontSize: "var(--text-small)" }}
          >
            {t("folders.list.new_label")}
          </label>
          <input
            id="folder-new-input"
            ref={inputRef}
            value={name}
            onChange={(e) => { setName(e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder={t("folders.list.new_placeholder")}
            className="mb-sp-5 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--base)] px-sp-4 py-sp-3 text-fg focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)]"
            style={{ fontSize: "var(--text-body)" }}
            maxLength={200}
          />
          <div className="flex justify-end gap-sp-3">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("folders.list.new_cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={submitting || !name.trim()}>
              {submitting ? t("folders.list.new_saving") : t("folders.list.new_save")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

const SORT_OPTIONS: { value: FolderSort; labelKey: string }[] = [
  { value: "name-asc", labelKey: "folders.list.sort_alpha" },
  { value: "created-desc", labelKey: "folders.list.sort_recent" },
  { value: "count-desc", labelKey: "folders.list.sort_count" },
];

export function FolderListPage() {
  const { t } = useTranslation();
  const data = useLoaderData<FolderListData>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  const { currentUserId, canShare } = useWorkspaceEntitlements();
  const { showToast, showError } = useAppToast();

  const [renaming, setRenaming] = useState<FolderListItem | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [delConfirm, setDelConfirm] = useState<FolderListItem | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [shareFolder, setShareFolder] = useState<FolderListItem | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);

  const isLoading = navigation.state === "loading";
  const isFiltered = data.q.length > 0 || data.scope !== "all";

  const currentSort = isFolderSort(data.sort) ? data.sort : "name-asc";
  const currentSortLabel = SORT_OPTIONS.find((s) => s.value === currentSort)?.labelKey ?? "folders.list.sort_alpha";

  // Scope detection for owner name
  const isSharedWithMe = data.scope === "shared-with-me";

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^(input|textarea|select)$/i.test((e.target as HTMLElement).tagName)) return;
      if (e.key === "Escape") {
        setRenaming(null);
        setDelConfirm(null);
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setShowNewDialog(true);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); };
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    };
    if (sortOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => { document.removeEventListener("mousedown", handleClickOutside); };
  }, [sortOpen]);

  const updateScope = (scope: SharingScope) => {
    const next = new URLSearchParams(searchParams);
    if (scope === "all") {
      next.delete("scope");
    } else {
      next.set("scope", scope);
    }
    next.delete("page");
    void navigate(`/folders?${next.toString()}`);
  };

  const updateSort = (sort: FolderSort) => {
    const next = new URLSearchParams(searchParams);
    next.set("sort", sort);
    next.delete("page");
    void navigate(`/folders?${next.toString()}`);
    setSortOpen(false);
  };

  const clearFilters = () => { void navigate("/folders"); };

  const handleMutationDone = () => {
    setRenaming(null);
    setDelConfirm(null);
    setShowNewDialog(false);
    void revalidator.revalidate();
  };

  const startRename = (folder: FolderListItem) => {
    setRenaming(folder);
    setRenameVal(folder.name);
    setDelConfirm(null);
  };

  const commitRename = async () => {
    if (!renaming) return;
    const trimmed = renameVal.trim();
    if (!trimmed || trimmed === renaming.name) {
      setRenaming(null);
      return;
    }
    try {
      await renameFolder(renaming.id, trimmed);
      showToast("folders.list.toast_renamed");
      void revalidator.revalidate();
    } catch {
      showError(t("folders.list.error_rename"));
    }
    setRenaming(null);
  };

  const commitDelete = async (folder: FolderListItem) => {
    try {
      await deleteFolder(folder.id);
      setDelConfirm(null);
      showToast("folders.list.toast_deleted");
      void revalidator.revalidate();
    } catch {
      showError(t("folders.list.error_delete"));
    }
  };

  if (isLoading) {
    return <FolderListSkeleton />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className="flex flex-wrap items-center gap-sp-3 border-b border-[color:var(--border)] px-sp-7 py-sp-2"
        data-testid="folder-list-toolbar"
      >
        <Form method="get" className="flex min-w-[12rem] max-w-[240px] flex-1 items-center gap-sp-2 rounded-md border border-[color:var(--border)] bg-[color:var(--base)] px-sp-3">
          <SearchIcon size={15} className="shrink-0 text-fg-muted" aria-hidden="true" />
          <input
            name="q"
            defaultValue={data.q}
            placeholder={t("folders.list.search_placeholder")}
            className="flex-1 bg-transparent py-sp-3 text-fg outline-none placeholder:text-fg-muted"
            style={{ fontSize: "var(--text-body)" }}
            data-testid="folder-list-search"
          />
          {data.q && (
            <button
              type="button"
              aria-label={t("bookmarks.list.clear_filters_action")}
              className="shrink-0 text-fg-faint hover:text-fg"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("q");
                void navigate(`/folders?${next.toString()}`);
              }}
            >
              <XIcon size={14} />
            </button>
          )}
        </Form>

        {canShare ? (
          <ScopeFilter
            value={data.scope}
            onChange={updateScope}
            resourceKind="folder"
          />
        ) : null}

        <div className="flex-1" />

        <span
          className="shrink-0 text-fg-subtle"
          style={{ fontSize: "var(--text-small)", fontFamily: "var(--font-mono)" }}
        >
          {t("folders.list.subtitle", { count: data.items.length })}
        </span>

        <div className="relative" ref={sortRef}>
          <button
            type="button"
            className={[
              "flex items-center gap-sp-2 rounded-md border border-[color:var(--border)] bg-[color:var(--base)] px-sp-3 py-sp-2 text-fg-muted transition-colors hover:bg-[color:var(--raised)]",
              currentSort !== "name-asc" ? "border-[color:var(--accent)] text-[color:var(--accent)]" : "",
            ].join(" ")}
            style={{ fontSize: "var(--text-small)" }}
            aria-expanded={sortOpen}
            onClick={() => { setSortOpen((o) => !o); }}
          >
            {t(currentSortLabel)}
          </button>
          {sortOpen && (
            <div className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-[190px] overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--overlay)] p-sp-2 shadow-lg">
              <p
                className="mb-sp-1 px-sp-3 text-fg-subtle"
                style={{ fontSize: "var(--text-small)" }}
              >
                {t("folders.list.sort_heading")}
              </p>
              {SORT_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className="flex w-full items-center gap-sp-3 rounded px-sp-3 py-sp-2 text-left text-fg transition-colors hover:bg-[color:var(--raised-2)]"
                  style={{ fontSize: "var(--text-body)" }}
                  onClick={() => { updateSort(s.value); }}
                >
                  {currentSort === s.value && (
                    <span className="text-[color:var(--accent)]">✓</span>
                  )}
                  <span className={currentSort === s.value ? "font-medium" : ""}>{t(s.labelKey)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => { setShowNewDialog(true); }}
          data-testid="folder-list-new-btn"
        >
          <FolderPlusIcon size={15} className="shrink-0" />
          {t("folders.list.new_action")}
          <kbd
            className="ml-sp-2 rounded bg-white/20 px-sp-2 py-0.5 text-[10px] font-medium text-white/80"
            aria-hidden="true"
          >
            N
          </kbd>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-sp-7" data-testid="folder-list-content">
      {data.items.length === 0 ? (
        <EmptyState
          illustration={<FolderOpenIcon size={40} strokeWidth={1.25} />}
          title={
            isFiltered
              ? t("folders.list.empty_title")
              : t("folders.list.empty_unfiltered_title")
          }
          description={
            isFiltered
              ? t("folders.list.empty_body")
              : t("folders.list.empty_unfiltered_body")
          }
          actions={
            isFiltered ? (
              <Button variant="secondary" type="button" onClick={clearFilters}>
                {t("folders.list.clear_filters_action")}
              </Button>
            ) : (
              <Button
                variant="primary"
                type="button"
                onClick={() => { setShowNewDialog(true); }}
              >
                <FolderPlusIcon size={15} className="shrink-0" />
                {t("folders.list.new_action")}
              </Button>
            )
          }
          testId="folder-list-empty-state"
        />
      ) : (
        <ul className="flex flex-col gap-sp-0" data-testid="folder-list">
          {data.items.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              currentUserId={currentUserId}
              canShare={canShare}
              isRenaming={renaming?.id === folder.id}
              isDelConfirm={delConfirm?.id === folder.id}
              renameVal={renaming?.id === folder.id ? renameVal : folder.name}
              ownerName={isSharedWithMe ? (data.ownerNames[folder.userId] ?? null) : null}
              onRenameStart={startRename}
              onRenameChange={setRenameVal}
              onRenameCommit={() => { void commitRename(); }}
              onRenameCancel={() => { setRenaming(null); }}
              onDelConfirm={(f) => { setDelConfirm(f); setRenaming(null); }}
              onDelCancel={() => { setDelConfirm(null); }}
              onDelCommit={(f) => { void commitDelete(f); }}
              onShareSettings={(f) => { setShareFolder(f); }}
            />
          ))}
        </ul>
      )}

      </div>

      {showNewDialog && (
        <NewFolderDialog
          onClose={() => { setShowNewDialog(false); }}
          onSaved={handleMutationDone}
        />
      )}

      {shareFolder && (
        <ShareDialog
          open={true}
          onOpenChange={(open) => { if (!open) setShareFolder(null); }}
          resourceKind="folder"
          resourceId={shareFolder.id}
          resourceTitle={shareFolder.name}
          onUpdated={() => { void revalidator.revalidate(); }}
        />
      )}
    </div>
  );
}
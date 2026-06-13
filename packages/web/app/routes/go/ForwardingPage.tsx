import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { Link2Icon, PencilIcon, Trash2Icon, UserIcon } from "lucide-react";
import { Button, ConfirmDialog, Dialog, DialogContent, EmptyState } from "@slugbase/ui";

import { useAppToast } from "../../components/feedback/AppToastProvider.js";
import type { GoCandidate } from "../../components/command-palette/go-mode-api.js";
import {
  deleteSlugPreference,
  fetchDisambiguationCandidates,
  updateSlugPreference,
} from "./forwarding-api.js";
import type { ForwardingLoaderData, SlugPreferenceItem } from "./forwarding-loader.js";

function SlugBadge({ slug }: { slug: string }) {
  return (
    <span className="inline-flex h-7 items-center rounded-md border border-[color:var(--accent-border)] bg-accent-subtle px-sp-3 font-mono text-[length:var(--text-small)] font-semibold text-accent-text">
      {slug}
    </span>
  );
}

interface PreferenceRowProps {
  item: SlugPreferenceItem;
  ownerLabel: string | null;
  onDelete: (item: SlugPreferenceItem) => void;
  onEdit: (item: SlugPreferenceItem) => void;
}

function PreferenceRow({ item, ownerLabel, onDelete, onEdit }: PreferenceRowProps) {
  const { t } = useTranslation();

  return (
    <div
      className="group flex items-start gap-sp-5 rounded-lg border border-[color:var(--border-subtle)] bg-canvas px-sp-5 py-sp-4 transition-colors hover:border-[color:var(--border)] hover:bg-raised"
      data-testid={`forwarding-pref-row-${item.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="mb-sp-3 flex flex-wrap items-center gap-sp-3">
          <SlugBadge slug={item.slug} />
          {item.isAmbiguous && (
            <span className="rounded-full bg-warning-subtle px-sp-3 py-[2px] text-[length:var(--text-micro)] font-medium text-warning-text">
              {t("go.forwarding.ambiguous_badge")}
            </span>
          )}
        </div>
        <p className="truncate text-[length:var(--text-body)] font-medium text-fg">
          {item.bookmarkTitle}
        </p>
        <p className="mt-[2px] truncate font-mono text-[length:var(--text-small)] text-fg-subtle">
          {item.bookmarkUrl}
        </p>
        {ownerLabel && (
          <p className="mt-sp-2 flex items-center gap-sp-2 text-[length:var(--text-small)] text-fg-subtle">
            <UserIcon size={13} className="shrink-0 text-fg-faint" aria-hidden />
            {ownerLabel}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-sp-2">
        {item.isAmbiguous && (
          <button
            type="button"
            data-testid={`forwarding-pref-edit-${item.id}`}
            aria-label={t("go.forwarding.action_edit")}
            onClick={() => { onEdit(item); }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-raised-2 hover:text-fg"
          >
            <PencilIcon size={15} aria-hidden />
          </button>
        )}
        <button
          type="button"
          data-testid={`forwarding-pref-delete-${item.id}`}
          aria-label={t("go.forwarding.action_delete")}
          onClick={() => { onDelete(item); }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-danger-subtle hover:text-danger-text"
        >
          <Trash2Icon size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}

interface EditPreferenceDialogProps {
  item: SlugPreferenceItem;
  candidates: GoCandidate[];
  loading: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (bookmarkId: string) => void;
}

function EditPreferenceDialog({
  item,
  candidates,
  loading,
  saving,
  onClose,
  onSave,
}: EditPreferenceDialogProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string>("");

  const effectiveSelectedId =
    selectedId || candidates.find((c) => c.id === item.bookmarkId)?.id || candidates[0]?.id || "";

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        title={t("go.forwarding.edit_title", { slug: item.slug })}
        testId="forwarding-pref-edit-dialog"
      >
        <div className="flex flex-col gap-sp-5 px-sp-8 py-sp-6">
            <p className="text-[length:var(--text-body)] text-fg-muted">
              {t("go.forwarding.edit_description")}
            </p>

            {loading ? (
              <p className="text-[length:var(--text-small)] text-fg-subtle">
                {t("go.forwarding.edit_loading")}
              </p>
            ) : (
              <div className="flex flex-col gap-sp-3">
                {candidates.map((candidate) => {
                  const isSelected = candidate.id === effectiveSelectedId;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      data-testid={`forwarding-pref-edit-candidate-${candidate.id}`}
                      onClick={() => { setSelectedId(candidate.id); }}
                      className={[
                        "flex w-full cursor-pointer items-start gap-sp-4 rounded-lg border p-sp-4 text-left transition-colors",
                        isSelected
                          ? "border-[color:var(--accent-border)] bg-accent-subtle"
                          : "border-[color:var(--border-subtle)] bg-canvas hover:border-[color:var(--border)] hover:bg-raised",
                      ].join(" ")}
                    >
                      <span
                        className={[
                          "mt-[3px] inline-grid h-[14px] w-[14px] shrink-0 place-items-center rounded-full border-2",
                          isSelected
                            ? "border-[color:var(--accent)] bg-accent"
                            : "border-[color:var(--border)] bg-canvas",
                        ].join(" ")}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[length:var(--text-body)] font-medium text-fg">
                          {candidate.title}
                        </span>
                        <span className="mt-[2px] block truncate font-mono text-[length:var(--text-small)] text-fg-faint">
                          {candidate.url}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex justify-end gap-sp-3">
              <Button type="button" variant="secondary" size="sm" onClick={onClose}>
                {t("go.forwarding.edit_cancel")}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={loading || saving || !effectiveSelectedId}
                onClick={() => { onSave(effectiveSelectedId); }}
              >
                {t("go.forwarding.edit_confirm")}
              </Button>
            </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ForwardingPage() {
  const { t } = useTranslation();
  const { items, ownerNames, currentUserId } = useLoaderData<ForwardingLoaderData>();
  const revalidator = useRevalidator();
  const { showToast, showError } = useAppToast();

  const [deleteTarget, setDeleteTarget] = useState<SlugPreferenceItem | null>(null);
  const [editTarget, setEditTarget] = useState<SlugPreferenceItem | null>(null);
  const [editCandidates, setEditCandidates] = useState<GoCandidate[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  const resolveOwnerLabel = (item: SlugPreferenceItem): string | null => {
    if (item.ownerUserId === currentUserId) return null;
    const name = ownerNames[item.ownerUserId];
    if (name) return t("go.forwarding.owner_label", { name });
    return t("go.forwarding.owner_label", { name: item.ownerUserId.slice(0, 8) });
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeletePending(true);
    try {
      await deleteSlugPreference(deleteTarget.id);
      showToast("go.forwarding.delete_success");
      setDeleteTarget(null);
      void revalidator.revalidate();
    } catch {
      showError(t("go.forwarding.delete_error"));
    } finally {
      setDeletePending(false);
    }
  };

  const handleEditOpen = async (item: SlugPreferenceItem) => {
    setEditLoading(true);
    setEditCandidates([]);
    try {
      const candidates = await fetchDisambiguationCandidates(item.slug);
      setEditCandidates(candidates);
      setEditTarget(item);
    } catch {
      showError(t("go.forwarding.edit_error"));
    } finally {
      setEditLoading(false);
    }
  };

  const handleEditClose = () => {
    setEditTarget(null);
    setEditCandidates([]);
    setEditLoading(false);
    setEditSaving(false);
  };

  const handleEditSave = async (bookmarkId: string) => {
    if (!editTarget) return;
    setEditSaving(true);
    try {
      await updateSlugPreference(editTarget.slug, bookmarkId);
      showToast("go.forwarding.edit_success");
      handleEditClose();
      void revalidator.revalidate();
    } catch {
      showError(t("go.forwarding.edit_error"));
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="forwarding-page">
      <div className="border-b border-[color:var(--border-subtle)] px-sp-7 py-sp-6">
        <h1 className="text-[length:var(--text-h2)] font-semibold text-fg">
          {t("go.forwarding.title")}
        </h1>
        <p className="mt-sp-2 max-w-[640px] text-[length:var(--text-body)] text-fg-muted">
          {t("go.forwarding.description")}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-sp-7">
        {items.length === 0 ? (
          <EmptyState
            illustration={<Link2Icon size={36} strokeWidth={1.25} />}
            title={t("go.forwarding.empty_title")}
            description={t("go.forwarding.empty_body")}
            testId="forwarding-prefs-empty"
          />
        ) : (
          <div className="flex flex-col gap-sp-3" data-testid="forwarding-prefs-list">
            {items.map((item) => (
              <PreferenceRow
                key={item.id}
                item={item}
                ownerLabel={resolveOwnerLabel(item)}
                onDelete={setDeleteTarget}
                onEdit={(pref) => { void handleEditOpen(pref); }}
              />
            ))}
          </div>
        )}
      </div>

      {deleteTarget !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          title={t("go.forwarding.delete_title")}
          description={t("go.forwarding.delete_body", {
            slug: deleteTarget.slug,
            title: deleteTarget.bookmarkTitle,
          })}
          confirmLabel={t("go.forwarding.delete_confirm")}
          cancelLabel={t("go.forwarding.delete_cancel")}
          onConfirm={() => { void handleDeleteConfirm(); }}
          destructive
          busy={deletePending}
          testId="forwarding-pref-delete-dialog"
        />
      )}

      {editTarget !== null && (
        <EditPreferenceDialog
          item={editTarget}
          candidates={editCandidates}
          loading={editLoading}
          saving={editSaving}
          onClose={handleEditClose}
          onSave={(bookmarkId) => { void handleEditSave(bookmarkId); }}
        />
      )}
    </div>
  );
}

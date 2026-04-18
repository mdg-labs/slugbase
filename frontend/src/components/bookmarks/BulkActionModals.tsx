import { useState, useMemo } from 'react';
import {
  FolderPlus,
  Tags,
} from 'lucide-react';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
import { ModalSection } from '../ui/ModalSection';
import { ModalFooterActions } from '../ui/ModalFooterActions';
import { Label } from '../ui/label';
import Autocomplete from '../ui/Autocomplete';
import SharingModal from '../modals/SharingModal';
import api from '../../api/client';
import { usePlan } from '../../contexts/PlanContext';
import { cn } from '@/lib/utils';

interface BulkMoveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (folderIds: string[]) => void;
  folders: Array<{ id: string; name: string }>;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

export function BulkMoveModal({ isOpen, onClose, onSave, folders, t }: BulkMoveModalProps) {
  const [selectedFolders, setSelectedFolders] = useState<Array<{ id: string; name: string }>>([]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave(selectedFolders.map(f => f.id));
    onClose();
  }

  const isValid = selectedFolders.length > 0;

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent className="flex max-w-[460px] flex-col border-[var(--border-strong)] bg-[var(--bg-1)] p-0">
        <ModalHead icon={FolderPlus} title={t('bookmarks.bulkMoveToFolder')} />

        <ModalBody>
          <form id="bulk-move-form" onSubmit={handleSubmit} className="space-y-6">
            <ModalSection>
              <Label className="mb-2 block font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--fg-3)]">
                {t('bookmarks.folders')}
              </Label>
              <Autocomplete
                value={selectedFolders}
                onChange={setSelectedFolders}
                options={folders}
                placeholder={t('bookmarks.foldersDescription')}
              />
            </ModalSection>
          </form>
        </ModalBody>

        <ModalFoot>
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            submitDisabled={!isValid}
            formId="bulk-move-form"
          />
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

interface BookmarkTagSummary {
  id: string;
  tags?: Array<{ id: string; name: string }>;
}

interface BulkTagModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tag IDs to add for every selected bookmark (merged with existing minus removals). */
  onSave: (tagIds: string[], removeTagIds: string[]) => void;
  tags: Array<{ id: string; name: string }>;
  onTagCreated?: (tag: { id: string; name: string }) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  /** When set with `selectedBookmarkIds`, shows merge preview. */
  contextBookmarks?: BookmarkTagSummary[];
  selectedBookmarkIds?: string[];
}

export function BulkTagModal({
  isOpen,
  onClose,
  onSave,
  tags,
  onTagCreated,
  t,
  contextBookmarks,
  selectedBookmarkIds,
}: BulkTagModalProps) {
  const [selectedTags, setSelectedTags] = useState<Array<{ id: string; name: string }>>([]);
  const [removeTags, setRemoveTags] = useState<Array<{ id: string; name: string }>>([]);

  async function handleCreateTag(name: string): Promise<{ id: string; name: string } | null> {
    try {
      const response = await api.post('/tags', { name });
      const newTag = { id: response.data.id, name: response.data.name };
      if (onTagCreated) {
        onTagCreated(newTag);
      }
      return newTag;
    } catch {
      return null;
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave(
      selectedTags.map(tag => tag.id),
      removeTags.map(tag => tag.id)
    );
    onClose();
  }

  const isValid = selectedTags.length > 0 || removeTags.length > 0;

  const preview = useMemo(() => {
    if (!contextBookmarks || !selectedBookmarkIds?.length) return null;
    let willGet = 0;
    let already = 0;
    const addIds = new Set(selectedTags.map((x) => x.id));
    const remIds = new Set(removeTags.map((x) => x.id));
    for (const id of selectedBookmarkIds) {
      const b = contextBookmarks.find((c) => c.id === id);
      const cur = new Set((b?.tags ?? []).map((x) => x.id));
      remIds.forEach((rid) => cur.delete(rid));
      const needsNew = [...addIds].some((aid) => !cur.has(aid));
      if (needsNew) willGet++;
      else if (addIds.size > 0) already++;
    }
    return { willGet, already, total: selectedBookmarkIds.length };
  }, [contextBookmarks, selectedBookmarkIds, selectedTags, removeTags]);

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent className="flex max-w-[460px] flex-col border-[var(--border-strong)] bg-[var(--bg-1)] p-0">
        <ModalHead icon={Tags} title={t('bookmarks.bulkAddTags')} />

        <ModalBody>
          <form id="bulk-tag-form" onSubmit={handleSubmit} className="space-y-6">
            <ModalSection>
              <Label className="mb-2 block font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--fg-3)]">
                {t('bookmarks.tags')}
              </Label>
              <Autocomplete
                value={selectedTags}
                onChange={setSelectedTags}
                options={tags}
                placeholder={t('bookmarks.tags')}
                onCreateNew={handleCreateTag}
                pillChips
              />

              <div className="pt-4">
                <Label className="mb-2 block font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--fg-3)]">
                  {t('bookmarks.bulkRemoveTagsOptional')}
                </Label>
                <Autocomplete
                  value={removeTags}
                  onChange={setRemoveTags}
                  options={tags}
                  placeholder={t('bookmarks.bulkRemoveTagsPlaceholder')}
                  pillChips
                />
              </div>

              {preview ? (
                <p className="text-[12px] text-[var(--fg-2)]">
                  {t('bookmarks.bulkTagPreview', {
                    willGet: preview.willGet,
                    already: preview.already,
                    total: preview.total,
                  })}
                </p>
              ) : null}
            </ModalSection>
          </form>
        </ModalBody>

        <ModalFoot>
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            submitDisabled={!isValid}
            formId="bulk-tag-form"
          />
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

interface BulkShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (sharing: { team_ids: string[]; user_ids: string[]; share_all_teams: boolean }) => void;
  teams: Array<{ id: string; name: string }>;
  t?: (key: string, opts?: Record<string, unknown>) => string;
}

export function BulkShareModal({ isOpen, onClose, onSave, teams }: BulkShareModalProps) {
  const planInfo = usePlan();
  const allowTeamSharing = planInfo ? planInfo.canShareWithTeams : teams.length > 0;
  return (
    <SharingModal
      isOpen={isOpen}
      onClose={onClose}
      onSave={onSave}
      currentShares={{
        team_ids: [],
        user_ids: [],
        share_all_teams: false,
      }}
      teams={teams}
      type="bookmark"
      allowTeamSharing={allowTeamSharing}
    />
  );
}

/** Floating bar styling for bulk selection — mockup `.card` + accent ring. */
export function bulkSelectionBarClassName(): string {
  return cn(
    'border border-[var(--accent-ring)] bg-[var(--bg-1)] shadow-[var(--shadow-lg)]',
    'ring-1 ring-inset ring-[var(--accent-ring)]/30'
  );
}

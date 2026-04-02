import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Separator } from '../ui/separator';
import { ModalSection } from '../ui/ModalSection';
import { ModalFooterActions } from '../ui/ModalFooterActions';
import { Label } from '../ui/label';
import Autocomplete from '../ui/Autocomplete';
import SharingModal from '../modals/SharingModal';
import api from '../../api/client';
import { usePlan } from '../../contexts/PlanContext';

interface BulkMoveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (folderIds: string[]) => void;
  folders: Array<{ id: string; name: string }>;
  t: any;
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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[460px] border-ghost bg-surface-high">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
            {t('bookmarks.bulkMoveToFolder')}
          </DialogTitle>
        </DialogHeader>
        <Separator className="bg-border/50" />

        <form id="bulk-move-form" onSubmit={handleSubmit} className="space-y-6">
          <ModalSection>
            <Label className="typography-label mb-2 block">{t('bookmarks.folders')}</Label>
            <Autocomplete
              value={selectedFolders}
              onChange={setSelectedFolders}
              options={folders}
              placeholder={t('bookmarks.foldersDescription')}
            />
          </ModalSection>
        </form>

        <Separator className="bg-border/50" />
        <DialogFooter className="flex-row justify-between gap-2 sm:justify-end">
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            submitDisabled={!isValid}
            formId="bulk-move-form"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface BulkTagModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (tagIds: string[]) => void;
  tags: Array<{ id: string; name: string }>;
  onTagCreated?: (tag: { id: string; name: string }) => void;
  t: any;
}

export function BulkTagModal({ isOpen, onClose, onSave, tags, onTagCreated, t }: BulkTagModalProps) {
  const [selectedTags, setSelectedTags] = useState<Array<{ id: string; name: string }>>([]);

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
    onSave(selectedTags.map(tag => tag.id));
    onClose();
  }

  const isValid = selectedTags.length > 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[460px] border-ghost bg-surface-high">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold tracking-tight text-foreground">
            {t('bookmarks.bulkAddTags')}
          </DialogTitle>
        </DialogHeader>
        <Separator className="bg-border/50" />

        <form id="bulk-tag-form" onSubmit={handleSubmit} className="space-y-6">
          <ModalSection>
            <Label className="typography-label mb-2 block">{t('bookmarks.tags')}</Label>
            <Autocomplete
              value={selectedTags}
              onChange={setSelectedTags}
              options={tags}
              placeholder={t('bookmarks.tags')}
              onCreateNew={handleCreateTag}
            />
          </ModalSection>
        </form>

        <Separator className="bg-border/50" />
        <DialogFooter className="flex-row justify-between gap-2 sm:justify-end">
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            submitDisabled={!isValid}
            formId="bulk-tag-form"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface BulkShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (sharing: { team_ids: string[]; user_ids: string[]; share_all_teams: boolean }) => void;
  teams: Array<{ id: string; name: string }>;
  t?: any;
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

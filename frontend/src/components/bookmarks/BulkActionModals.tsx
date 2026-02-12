import { useState } from 'react';
import Modal from '../ui/Modal';
import Autocomplete from '../ui/Autocomplete';
import Button from '../ui/Button';
import SharingModal from '../modals/SharingModal';
import api from '../../api/client';
import { useOrgPlan } from '../../contexts/OrgPlanContext';
import { canShareToTeams } from '../../utils/plan';

interface BulkMoveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (folderIds: string[]) => void;
  folders: Array<{ id: string; name: string }>;
  t: any;
}

export function BulkMoveModal({ isOpen, onClose, onSave, folders, t }: BulkMoveModalProps) {
  const [selectedFolders, setSelectedFolders] = useState<Array<{ id: string; name: string }>>([]);

  function handleSave() {
    onSave(selectedFolders.map(f => f.id));
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('bookmarks.bulkMoveToFolder')} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
            {t('bookmarks.folders')}
          </label>
          <Autocomplete
            value={selectedFolders}
            onChange={setSelectedFolders}
            options={folders}
            placeholder={t('bookmarks.foldersDescription')}
          />
        </div>
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} className="flex-1">
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
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

  function handleSave() {
    onSave(selectedTags.map(t => t.id));
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('bookmarks.bulkAddTags')} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
            {t('bookmarks.tags')}
          </label>
          <Autocomplete
            value={selectedTags}
            onChange={setSelectedTags}
            options={tags}
            placeholder={t('bookmarks.tags')}
            onCreateNew={handleCreateTag}
          />
        </div>
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} className="flex-1">
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
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
  const { plan } = useOrgPlan();
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
      allowTeamSharing={canShareToTeams(plan)}
    />
  );
}

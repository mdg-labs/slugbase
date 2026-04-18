import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Share2 } from 'lucide-react';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
import { ModalFooterActions } from '../ui/ModalFooterActions';
import { SharingField } from '../ui/SharingField';

interface Team {
  id: string;
  name: string;
  description?: string;
}

interface SharingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (sharing: { user_ids: string[]; team_ids: string[]; share_all_teams: boolean }) => void;
  currentShares?: {
    user_ids?: string[];
    team_ids?: string[];
    share_all_teams?: boolean;
  };
  teams: Team[];
  type?: 'bookmark' | 'folder';
  allowTeamSharing?: boolean;
}

export default function SharingModal({
  isOpen,
  onClose,
  onSave,
  currentShares = {},
  teams,
  allowTeamSharing = true,
}: SharingModalProps) {
  const { t } = useTranslation();
  const [sharing, setSharing] = useState({
    user_ids: currentShares.user_ids || [],
    team_ids: currentShares.team_ids || [],
    share_all_teams: currentShares.share_all_teams || false,
  });

  useEffect(() => {
    if (isOpen) {
      setSharing({
        user_ids: currentShares.user_ids || [],
        team_ids: currentShares.team_ids || [],
        share_all_teams: currentShares.share_all_teams || false,
      });
    }
  }, [isOpen, currentShares.user_ids, currentShares.team_ids, currentShares.share_all_teams]);

  function handleSave() {
    onSave({
      user_ids: sharing.user_ids,
      team_ids: allowTeamSharing ? (sharing.share_all_teams ? [] : sharing.team_ids) : [],
      share_all_teams: allowTeamSharing && sharing.share_all_teams,
    });
    onClose();
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent className="flex max-h-[90vh] max-w-lg flex-col p-0">
        <ModalHead icon={Share2} title={t('bookmarks.shareWithTeams')} />

        <ModalBody>
          <form id="sharing-form" onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="space-y-6">
            <SharingField
              value={sharing}
              onChange={setSharing}
              teams={teams}
              allowTeamSharing={allowTeamSharing}
            />
          </form>
        </ModalBody>

        <ModalFoot>
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            formId="sharing-form"
          />
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

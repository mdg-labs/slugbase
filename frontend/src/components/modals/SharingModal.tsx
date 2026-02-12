import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../api/client';
import { isCloud } from '../../config/mode';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Users, User, Search, X, Check, UserPlus } from 'lucide-react';

interface Team {
  id: string;
  name: string;
  description?: string;
}

interface User {
  id: string;
  name: string;
  email: string;
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
}

export default function SharingModal({
  isOpen,
  onClose,
  onSave,
  currentShares = {},
  teams,
}: SharingModalProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>(currentShares.user_ids || []);
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(currentShares.team_ids || []);
  const [shareAllTeams, setShareAllTeams] = useState<boolean>(currentShares.share_all_teams || false);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [teamSearchQuery, setTeamSearchQuery] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadUsers();
      if (currentShares.user_ids) {
        setSelectedUserIds(currentShares.user_ids);
      }
      if (currentShares.team_ids) {
        setSelectedTeamIds(currentShares.team_ids);
      }
      if (currentShares.share_all_teams !== undefined) {
        setShareAllTeams(currentShares.share_all_teams);
      }
    }
  }, [isOpen, currentShares]);

  async function loadUsers() {
    try {
      const endpoint = isCloud ? '/organizations/members' : '/admin/users';
      const response = await api.get(endpoint);
      const users = Array.isArray(response.data) ? response.data : [];
      setAllUsers(users.filter((u: User) => u.id !== user?.id)); // Exclude self
    } catch (error) {
      console.error('Failed to load users:', error);
    }
  }

  const filteredUsers = allUsers.filter((u) => {
    if (!userSearchQuery.trim()) return true;
    const query = userSearchQuery.toLowerCase();
    return u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query);
  });

  const filteredTeams = teams.filter((t) => {
    if (!teamSearchQuery.trim()) return true;
    const query = teamSearchQuery.toLowerCase();
    return t.name.toLowerCase().includes(query) || (t.description && t.description.toLowerCase().includes(query));
  });

  function handleSave() {
    onSave({
      user_ids: selectedUserIds,
      team_ids: shareAllTeams ? [] : selectedTeamIds,
      share_all_teams: shareAllTeams,
    });
    onClose();
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('bookmarks.shareWithTeams')}
      size="lg"
    >
      <div className="space-y-6">
        {/* Share with All Teams */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={shareAllTeams}
              onChange={(e) => {
                setShareAllTeams(e.target.checked);
                if (e.target.checked) {
                  setSelectedTeamIds([]);
                }
              }}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
            />
            <div>
              <span className="text-sm font-semibold text-gray-900 dark:text-white">
                {t('bookmarks.shareAllTeams')}
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('bookmarks.shareAllTeamsDescription')}
              </p>
            </div>
          </label>
        </div>

        {/* Share with Specific Teams */}
        {!shareAllTeams && (
          <div>
            <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              <Users className="inline h-4 w-4 mr-1.5" />
              {t('bookmarks.shareWithTeams')}
            </label>
            <div className="mb-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder={t('admin.searchTeams')}
                  value={teamSearchQuery}
                  onChange={(e) => setTeamSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">
              {filteredTeams.map((team) => (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => {
                    setSelectedTeamIds((prev) =>
                      prev.includes(team.id)
                        ? prev.filter((id) => id !== team.id)
                        : [...prev, team.id]
                    );
                  }}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    selectedTeamIds.includes(team.id)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                >
                  {selectedTeamIds.includes(team.id) && <Check className="h-3 w-3" />}
                  {team.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Share with Specific Users */}
        <div>
          <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
            <User className="inline h-4 w-4 mr-1.5" />
            {t('bookmarks.shareWithUsers')}
          </label>
          <div className="mb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder={t('admin.searchUsers')}
                value={userSearchQuery}
                onChange={(e) => setUserSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          {selectedUserIds.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {selectedUserIds.map((userId) => {
                const user = allUsers.find((u) => u.id === userId);
                if (!user) return null;
                return (
                  <span
                    key={userId}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 rounded-lg"
                  >
                    {user.name}
                    <button
                      type="button"
                      onClick={() => setSelectedUserIds((prev) => prev.filter((id) => id !== userId))}
                      className="hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {filteredUsers
              .filter((u) => !selectedUserIds.includes(u.id))
              .map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => setSelectedUserIds((prev) => [...prev, user.id])}
                  className="w-full flex items-center justify-between px-4 py-2 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 transition-colors text-left"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{user.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
                  </div>
                  <Button variant="primary" size="sm" icon={UserPlus}>
                    {t('admin.add')}
                  </Button>
                </button>
              ))}
          </div>
        </div>

        <div className="flex gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
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

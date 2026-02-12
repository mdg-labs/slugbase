import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { isCloud } from '../../config/mode';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { UserPlus, X, Users, User, Search } from 'lucide-react';

interface Team {
  id: string;
  name: string;
  description?: string;
}

interface User {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
}

interface TeamAssignmentModalProps {
  mode: 'user' | 'team';
  userId?: string;
  userName?: string;
  teamId?: string;
  teamName?: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TeamAssignmentModal({
  mode,
  userId,
  userName,
  teamId,
  teamName,
  isOpen,
  onClose,
  onSuccess,
}: TeamAssignmentModalProps) {
  const { t } = useTranslation();
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [userTeams, setUserTeams] = useState<Team[]>([]);
  const [teamMembers, setTeamMembers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (isOpen) {
      setSearchQuery(''); // Reset search when modal opens
      loadData();
    }
  }, [isOpen, mode, userId, teamId]);

  async function loadData() {
    try {
      setLoading(true);
      if (mode === 'user' && userId) {
        // Load all teams and user's teams
        const [teamsRes, userTeamsRes] = await Promise.all([
          api.get('/admin/teams'),
          api.get(`/admin/users/${userId}/teams`).catch(() => ({ data: [] })),
        ]);
        setAllTeams(teamsRes.data);
        setUserTeams(userTeamsRes.data || []);
      } else if (mode === 'team' && teamId) {
        // Load all users and team's members (in Cloud mode, use org members for user list)
        const usersEndpoint = isCloud ? '/organizations/members' : '/admin/users';
        const [usersRes, teamRes] = await Promise.all([
          api.get(usersEndpoint),
          api.get(`/admin/teams/${teamId}`),
        ]);
        setAllUsers(Array.isArray(usersRes.data) ? usersRes.data : []);
        setTeamMembers(teamRes.data.members || []);
      }
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(userIdToAdd: string, teamIdToAdd: string) {
    try {
      setSaving(true);
      await api.post(`/admin/teams/${teamIdToAdd}/members`, { user_id: userIdToAdd });
      setSearchQuery(''); // Reset search after adding
      await loadData();
      onSuccess();
    } catch (error: any) {
      alert(error.response?.data?.error || t('common.error'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(userIdToRemove: string, teamIdToRemove: string) {
    try {
      setSaving(true);
      await api.delete(`/admin/teams/${teamIdToRemove}/members/${userIdToRemove}`);
      setSearchQuery(''); // Reset search after removing
      await loadData();
      onSuccess();
    } catch (error: any) {
      alert(error.response?.data?.error || t('common.error'));
    } finally {
      setSaving(false);
    }
  }

  // Filter function for search
  const filterTeams = (teams: Team[]) => {
    if (!searchQuery.trim()) return teams;
    const query = searchQuery.toLowerCase();
    return teams.filter(
      (team) =>
        team.name.toLowerCase().includes(query) ||
        (team.description && team.description.toLowerCase().includes(query))
    );
  };

  const filterUsers = (users: User[]) => {
    if (!searchQuery.trim()) return users;
    const query = searchQuery.toLowerCase();
    return users.filter(
      (user) =>
        user.name.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query)
    );
  };

  if (mode === 'user') {
    const userTeamIds = new Set(userTeams.map((t) => t.id));
    const availableTeams = filterTeams(allTeams.filter((t) => !userTeamIds.has(t.id)));

    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={t('admin.manageTeamsTitle', { userName })}
        size="lg"
      >
        {loading ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            {t('common.loading')}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Current Teams */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <Users className="h-4 w-4" />
                {t('admin.currentTeams')} ({userTeams.length})
              </h3>
              {userTeams.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 py-4">
                  {t('admin.noTeams')}
                </p>
              ) : (
                <div className="space-y-2">
                  {userTeams.map((team) => (
                    <div
                      key={team.id}
                      className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">
                          {team.name}
                        </p>
                        {team.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">{team.description}</p>
                        )}
                      </div>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={X}
                        onClick={() => userId && handleRemove(userId, team.id)}
                        disabled={saving}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Available Teams */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <UserPlus className="h-4 w-4" />
                {t('admin.addTeams')} ({availableTeams.length})
              </h3>
              <div className="mb-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder={t('admin.searchTeams')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              {availableTeams.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
                  {allTeams.filter((t) => !userTeamIds.has(t.id)).length === 0
                    ? t('admin.noTeamsAvailable')
                    : t('admin.noSearchResults')}
                </p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {availableTeams.map((team) => (
                    <div
                      key={team.id}
                      className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">
                          {team.name}
                        </p>
                        {team.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">{team.description}</p>
                        )}
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        icon={UserPlus}
                        onClick={() => userId && handleAdd(userId, team.id)}
                        disabled={saving}
                      >
                        {t('admin.add')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-4 border-t border-gray-200 dark:border-gray-700">
              <Button variant="secondary" onClick={onClose}>
                {t('common.close')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    );
  } else {
    // mode === 'team'
    const memberIds = new Set(teamMembers.map((m) => m.id));
    const availableUsers = filterUsers(allUsers.filter((u) => !memberIds.has(u.id)));

    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={t('admin.manageMembersTitle', { teamName })}
        size="lg"
      >
        {loading ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            {t('common.loading')}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Current Members */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <Users className="h-4 w-4" />
                {t('admin.currentMembers')} ({teamMembers.length})
              </h3>
              {teamMembers.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 py-4">
                  {t('admin.noMembers')}
                </p>
              ) : (
                <div className="space-y-2">
                  {teamMembers.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">
                          {member.name}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{member.email}</p>
                      </div>
                      <Button
                        variant="danger"
                        size="sm"
                        icon={X}
                        onClick={() => teamId && handleRemove(member.id, teamId)}
                        disabled={saving}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Available Users */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <UserPlus className="h-4 w-4" />
                {t('admin.addMembers')} ({availableUsers.length})
              </h3>
              <div className="mb-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder={t('admin.searchUsers')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              {availableUsers.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
                  {allUsers.filter((u) => !memberIds.has(u.id)).length === 0
                    ? t('admin.noUsersAvailable')
                    : t('admin.noSearchResults')}
                </p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {availableUsers.map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center justify-between px-4 py-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">
                          {user.name}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        icon={UserPlus}
                        onClick={() => teamId && handleAdd(user.id, teamId)}
                        disabled={saving}
                      >
                        {t('admin.add')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-4 border-t border-gray-200 dark:border-gray-700">
              <Button variant="secondary" onClick={onClose}>
                {t('common.close')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    );
  }
}

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
import { Input } from '../ui/input';
import Button from '../ui/Button';
import { UserRound, UserPlus, X, Users, Search } from 'lucide-react';

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
      setSearchQuery('');
      loadData();
    }
  }, [isOpen, mode, userId, teamId]);

  async function loadData() {
    try {
      setLoading(true);
      if (mode === 'user' && userId) {
        const [teamsRes, userTeamsRes] = await Promise.all([
          api.get('/admin/teams'),
          api.get(`/admin/users/${userId}/teams`).catch(() => ({ data: [] })),
        ]);
        setAllTeams(teamsRes.data);
        setUserTeams(userTeamsRes.data || []);
      } else if (mode === 'team' && teamId) {
        const [usersRes, teamRes] = await Promise.all([
          api.get('/admin/users'),
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
      setSearchQuery('');
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
      setSearchQuery('');
      await loadData();
      onSuccess();
    } catch (error: any) {
      alert(error.response?.data?.error || t('common.error'));
    } finally {
      setSaving(false);
    }
  }

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
      <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <ModalContent wide className="flex max-h-[calc(100vh-4rem)] flex-col overflow-hidden p-0">
          <ModalHead icon={UserRound} title={t('admin.manageTeamsTitle', { userName })} />

          {loading ? (
            <ModalBody>
              <div className="py-8 text-center text-[12.5px] text-[var(--fg-2)]">{t('common.loading')}</div>
            </ModalBody>
          ) : (
            <ModalBody>
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  {t('admin.currentTeams')} ({userTeams.length})
                </h3>
                {userTeams.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">{t('admin.noTeams')}</p>
                ) : (
                  <div className="space-y-2">
                    {userTeams.map((team) => (
                      <div
                        key={team.id}
                        className="flex items-center justify-between px-4 py-3 rounded-lg border bg-muted/50"
                      >
                        <div>
                          <p className="text-sm font-medium">{team.name}</p>
                          {team.description && (
                            <p className="text-xs text-muted-foreground">{team.description}</p>
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

              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <UserPlus className="h-4 w-4" />
                  {t('admin.addTeams')} ({availableTeams.length})
                </h3>
                <div className="relative mb-3">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="text"
                    placeholder={t('admin.searchTeams')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                {availableTeams.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    {allTeams.filter((t) => !userTeamIds.has(t.id)).length === 0
                      ? t('admin.noTeamsAvailable')
                      : t('admin.noSearchResults')}
                  </p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {availableTeams.map((team) => (
                      <div
                        key={team.id}
                        className="flex items-center justify-between px-4 py-3 rounded-lg border hover:border-primary/50 transition-colors"
                      >
                        <div>
                          <p className="text-sm font-medium">{team.name}</p>
                          {team.description && (
                            <p className="text-xs text-muted-foreground">{team.description}</p>
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
            </div>
            </ModalBody>
          )}

          <ModalFoot>
            <Button variant="ghost" type="button" size="md" onClick={onClose}>
              {t('common.close')}
            </Button>
          </ModalFoot>
        </ModalContent>
      </Modal>
    );
  }

  const memberIds = new Set(teamMembers.map((m) => m.id));
  const availableUsers = filterUsers(allUsers.filter((u) => !memberIds.has(u.id)));

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent wide className="flex max-h-[calc(100vh-4rem)] flex-col overflow-hidden p-0">
        <ModalHead icon={Users} title={t('admin.manageMembersTitle', { teamName })} />

        {loading ? (
          <ModalBody>
            <div className="py-8 text-center text-[12.5px] text-[var(--fg-2)]">{t('common.loading')}</div>
          </ModalBody>
        ) : (
          <ModalBody>
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Users className="h-4 w-4" />
                {t('admin.currentMembers')} ({teamMembers.length})
              </h3>
              {teamMembers.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">{t('admin.noMembers')}</p>
              ) : (
                <div className="space-y-2">
                  {teamMembers.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center justify-between px-4 py-3 rounded-lg border bg-muted/50"
                    >
                      <div>
                        <p className="text-sm font-medium">{member.name}</p>
                        <p className="text-xs text-muted-foreground">{member.email}</p>
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

            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <UserPlus className="h-4 w-4" />
                {t('admin.addMembers')} ({availableUsers.length})
              </h3>
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder={t('admin.searchUsers')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              {availableUsers.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  {allUsers.filter((u) => !memberIds.has(u.id)).length === 0
                    ? t('admin.noUsersAvailable')
                    : t('admin.noSearchResults')}
                </p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {availableUsers.map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center justify-between px-4 py-3 rounded-lg border hover:border-primary/50 transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium">{user.name}</p>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
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
          </div>
          </ModalBody>
        )}

        <ModalFoot>
          <Button variant="ghost" type="button" size="md" onClick={onClose}>
            {t('common.close')}
          </Button>
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

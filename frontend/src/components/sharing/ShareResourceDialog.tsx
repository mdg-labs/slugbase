import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { usePlan } from '../../contexts/PlanContext';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import { useToast } from '../ui/Toast';
import { Check, Copy, Link2, Share2, User, Users, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SharedUser {
  id: string;
  name: string;
  email: string;
}

interface SharedTeam {
  id: string;
  name: string;
}

interface ShareResourceDialogProps {
  resourceType: 'bookmark' | 'folder';
  resourceId: string;
  resourceName: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ShareResourceDialog({
  resourceType,
  resourceId,
  resourceName: _resourceName,
  isOpen,
  onClose,
  onSuccess,
}: ShareResourceDialogProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharedUsers, setSharedUsers] = useState<SharedUser[]>([]);
  const [sharedTeams, setSharedTeams] = useState<SharedTeam[]>([]);
  const [resourceData, setResourceData] = useState<{ name?: string; icon?: string | null } | null>(null);
  const [bookmarkUrl, setBookmarkUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [allUsers, setAllUsers] = useState<SharedUser[]>([]);
  const [teams, setTeams] = useState<SharedTeam[]>([]);
  const [emailInput, setEmailInput] = useState('');
  const [peopleDropdownOpen, setPeopleDropdownOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'people' | 'teams'>('people');

  const MIN_CHARS_FOR_USER_DROPDOWN = 3;
  const planInfo = usePlan();
  const allowShareToTeams = planInfo ? planInfo.canShareWithTeams : teams.length > 0;
  const allowShareToUsers = true;

  const refreshResourceOnly = useCallback(async () => {
    if (!resourceId) return;
    try {
      const endpoint = resourceType === 'bookmark' ? `/bookmarks/${resourceId}` : `/folders/${resourceId}`;
      const res = await api.get(endpoint);
      const data = res.data;
      setSharedUsers(data.shared_users ?? []);
      setSharedTeams(data.shared_teams ?? []);
      setResourceData(resourceType === 'folder' ? { name: data.name, icon: data.icon } : null);
      setBookmarkUrl(resourceType === 'bookmark' && typeof data.url === 'string' ? data.url : null);
    } catch {
      // ignore
    }
  }, [resourceId, resourceType]);

  const loadAll = useCallback(async () => {
    if (!resourceId || !isOpen) return;
    setLoading(true);
    setError(null);
    const endpoint = resourceType === 'bookmark' ? `/bookmarks/${resourceId}` : `/folders/${resourceId}`;

    const [resourceResult, usersResult, teamsResult] = await Promise.allSettled([
      api.get(endpoint),
      (async () => {
        try {
          const res = await api.get('/users/for-sharing');
          return Array.isArray(res.data) ? res.data : [];
        } catch (e: any) {
          try {
            const adminRes = await api.get('/admin/users');
            const list = Array.isArray(adminRes.data) ? adminRes.data : [];
            return list.filter((u: SharedUser) => u.id && u.email);
          } catch {
            return [];
          }
        }
      })(),
      api.get('/teams').then((r) => r.data).catch(() => []),
    ]);

    if (resourceResult.status === 'fulfilled') {
      const data = resourceResult.value.data;
      setSharedUsers(data.shared_users ?? []);
      setSharedTeams(data.shared_teams ?? []);
      setResourceData(resourceType === 'folder' ? { name: data.name, icon: data.icon } : null);
      setBookmarkUrl(resourceType === 'bookmark' && typeof data.url === 'string' ? data.url : null);
    } else {
      setError(t('common.error'));
      showToast(t('common.error'), 'error');
    }

    setAllUsers(usersResult.status === 'fulfilled' ? usersResult.value : []);
    const teamsData = teamsResult.status === 'fulfilled' ? teamsResult.value : [];
    setTeams(Array.isArray(teamsData) ? teamsData : teamsData != null ? [teamsData] : []);

    setLoading(false);
  }, [resourceId, resourceType, isOpen, t, showToast]);

  useEffect(() => {
    if (isOpen) loadAll();
  }, [isOpen, loadAll]);

  async function updateShares(userIds: string[], teamIds: string[], shareAllTeams: boolean) {
    setSaving(true);
    setError(null);
    try {
      const endpoint = resourceType === 'bookmark' ? `/bookmarks/${resourceId}` : `/folders/${resourceId}`;
      const payload: Record<string, unknown> = { user_ids: userIds };
      if (resourceType === 'folder' && resourceData) {
        payload.name = resourceData.name;
        payload.icon = resourceData.icon ?? null;
      }
      if (allowShareToTeams) {
        payload.team_ids = shareAllTeams ? [] : teamIds;
        payload.share_all_teams = shareAllTeams;
      }
      await api.put(endpoint, payload);
      await refreshResourceOnly();
      onSuccess();
      showToast(t('common.success'), 'success');
    } catch (err: any) {
      const msg = err.response?.data?.error || t('common.error');
      setError(msg);
      showToast(msg, 'error');
      setSaving(false);
      throw err;
    }
    setSaving(false);
  }

  function handleRemoveUser(userId: string) {
    const newUserIds = sharedUsers.filter((u) => u.id !== userId).map((u) => u.id);
    updateShares(newUserIds, sharedTeams.map((t) => t.id), false);
  }

  function handleRemoveTeam(teamId: string) {
    const newTeamIds = sharedTeams.filter((t) => t.id !== teamId).map((t) => t.id);
    updateShares(sharedUsers.map((u) => u.id), newTeamIds, false);
  }

  function handleAddUser(userId: string) {
    if (sharedUsers.some((u) => u.id === userId)) return;
    const userToAdd = allUsers.find((u) => u.id === userId);
    const newUserIds = [...sharedUsers.map((u) => u.id), userId];
    if (userToAdd) {
      setSharedUsers((prev) => [...prev, userToAdd]);
    }
    setPeopleDropdownOpen(false);
    setEmailInput('');
    updateShares(newUserIds, sharedTeams.map((t) => t.id), false).catch(() => {
      if (userToAdd) {
        setSharedUsers((prev) => prev.filter((u) => u.id !== userId));
      }
    });
  }

  function handleAddUserByEmail() {
    const email = emailInput.trim().toLowerCase();
    if (!email) return;
    const matched = allUsers.find((u) => u.email.toLowerCase() === email);
    if (matched) {
      handleAddUser(matched.id);
    } else {
      showToast(t('sharing.emailNotAssociated'), 'error');
    }
  }

  function handleAddTeam(teamId: string) {
    if (sharedTeams.some((t) => t.id === teamId)) return;
    const teamToAdd = teams.find((t) => t.id === teamId);
    const newTeamIds = [...sharedTeams.map((t) => t.id), teamId];
    if (teamToAdd) {
      setSharedTeams((prev) => [...prev, teamToAdd]);
    }
    updateShares(sharedUsers.map((u) => u.id), newTeamIds, false).catch(() => {
      if (teamToAdd) {
        setSharedTeams((prev) => prev.filter((t) => t.id !== teamId));
      }
    });
  }

  const searchQuery = emailInput.trim().toLowerCase();
  const filteredUsers = allUsers.filter((u) => {
    if (!searchQuery) return false;
    return (
      u.email.toLowerCase().includes(searchQuery) ||
      (u.name && u.name.toLowerCase().includes(searchQuery))
    );
  });
  const usersAvailableToAdd = filteredUsers.filter((u) => !sharedUsers.some((su) => su.id === u.id));
  const showUserDropdown =
    searchQuery.length >= MIN_CHARS_FOR_USER_DROPDOWN && usersAvailableToAdd.length > 0;

  const filteredTeams = teams.filter((t) => !sharedTeams.some((st) => st.id === t.id));

  const hasShares = sharedUsers.length > 0 || sharedTeams.length > 0;

  const title = resourceType === 'bookmark' ? t('sharing.shareBookmark') : t('sharing.shareFolder');

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent wide className="flex max-h-[90vh] flex-col p-0">
        <ModalHead icon={Share2} title={title} />

        <ModalBody>
          <p className="-mt-1 mb-4 text-[12.5px] text-[var(--fg-2)]">{t('sharing.inviteDescription')}</p>

          {loading ? (
            <div className="space-y-4 py-4">
              <div className="h-20 animate-pulse rounded-[var(--radius-sm)] bg-[var(--bg-2)]" />
              <div className="h-20 animate-pulse rounded-[var(--radius-sm)] bg-[var(--bg-2)]" />
            </div>
          ) : (
            <div className="space-y-6">
              {error && (
                <div className="rounded-[var(--radius-sm)] bg-[rgba(248,113,113,0.1)] px-3 py-2 text-[12.5px] text-[var(--danger)]">
                  {error}
                </div>
              )}

              <div>
                <h4 className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--fg-3)]">
                  {t('sharing.peopleWithAccess')}
                </h4>
                {!hasShares ? (
                  <p className="text-[12.5px] text-[var(--fg-2)]">{t('sharing.notSharedYet')}</p>
                ) : (
                  <ScrollArea className="max-h-32 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] p-2">
                    <div className="space-y-1.5">
                      {allowShareToTeams && sharedTeams.map((team) => (
                        <div
                          key={team.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-soft)] bg-[var(--bg-1)] px-2 py-1.5"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <Users className="h-4 w-4 shrink-0 text-[var(--fg-3)]" />
                            <span className="truncate text-[12.5px] text-[var(--fg-0)]">{team.name}</span>
                          </div>
                          <Tooltip content={t('sharing.removeAccess')}>
                            <button
                              type="button"
                              onClick={() => handleRemoveTeam(team.id)}
                              disabled={saving}
                              className="rounded p-1 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]"
                              aria-label={t('sharing.removeAccess')}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        </div>
                      ))}
                      {sharedUsers.map((u) => (
                        <div
                          key={u.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-soft)] bg-[var(--bg-1)] px-2 py-1.5"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <User className="h-4 w-4 shrink-0 text-[var(--fg-3)]" />
                            <span className="truncate text-[12.5px] text-[var(--fg-0)]">{u.name || u.email}</span>
                            {u.name ? (
                              <span className="truncate text-[11px] text-[var(--fg-3)]">({u.email})</span>
                            ) : null}
                          </div>
                          <Tooltip content={t('sharing.removeAccess')}>
                            <button
                              type="button"
                              onClick={() => handleRemoveUser(u.id)}
                              disabled={saving}
                              className="rounded p-1 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]"
                              aria-label={t('sharing.removeAccess')}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>

              <div className="border-t border-[var(--border)] pt-4">
                <h4 className="mb-3 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--fg-3)]">
                  {t('sharing.addAccess')}
                </h4>
                {!loading && allUsers.length === 0 && teams.length === 0 && (
                  <p className="mb-2 text-[11px] text-[var(--warn)]" role="status">
                    {t('sharing.noUsersOrTeams')}
                  </p>
                )}
                {allowShareToTeams && allowShareToUsers ? (
                  <div className="mb-3 flex gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] p-0.5">
                    <button
                      type="button"
                      onClick={() => setActiveTab('people')}
                      className={cn(
                        'flex-1 rounded px-2.5 py-1 font-mono text-[11.5px] font-medium transition-colors',
                        activeTab === 'people'
                          ? 'bg-[var(--bg-4)] text-[var(--fg-0)]'
                          : 'text-[var(--fg-2)] hover:text-[var(--fg-0)]'
                      )}
                    >
                      {t('sharing.people')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('teams')}
                      className={cn(
                        'flex-1 rounded px-2.5 py-1 font-mono text-[11.5px] font-medium transition-colors',
                        activeTab === 'teams'
                          ? 'bg-[var(--bg-4)] text-[var(--fg-0)]'
                          : 'text-[var(--fg-2)] hover:text-[var(--fg-0)]'
                      )}
                    >
                      {t('sharing.teams')}
                    </button>
                  </div>
                ) : null}

                {allowShareToUsers && (activeTab === 'people' || !allowShareToTeams) && (
                  <div className="space-y-2">
                    <div className="relative">
                      <Input
                        placeholder={t('admin.searchUsers')}
                        value={emailInput}
                        onChange={(e) => {
                          setEmailInput(e.target.value);
                          setPeopleDropdownOpen(true);
                        }}
                        onFocus={() => {
                          if (searchQuery.length >= MIN_CHARS_FOR_USER_DROPDOWN)
                            setPeopleDropdownOpen(true);
                        }}
                        onBlur={() => {
                          setTimeout(() => setPeopleDropdownOpen(false), 150);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddUserByEmail();
                          }
                        }}
                        className="w-full"
                        autoComplete="off"
                        leftSlot={<User className="text-[var(--fg-3)]" strokeWidth={1.75} />}
                      />
                      {peopleDropdownOpen && showUserDropdown && (
                        <div
                          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] shadow-[var(--shadow-lg)]"
                          role="listbox"
                        >
                          {usersAvailableToAdd.map((u) => (
                            <button
                              key={u.id}
                              type="button"
                              role="option"
                              className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-[12.5px] text-[var(--fg-0)] hover:bg-[var(--accent-bg)] focus:bg-[var(--accent-bg)] focus:outline-none"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                handleAddUser(u.id);
                              }}
                            >
                              <span className="font-medium">{u.name || u.email}</span>
                              {u.name && u.email && (
                                <span className="text-[11px] text-[var(--fg-3)]">{u.email}</span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="text-[11px] text-[var(--fg-3)]">
                      {t('sharing.typeToSearchUsers', { count: MIN_CHARS_FOR_USER_DROPDOWN })}
                    </p>
                  </div>
                )}

                {allowShareToTeams && (activeTab === 'teams' || !allowShareToUsers) && (
                  <div className="space-y-2">
                    <p className="text-[11px] text-[var(--fg-3)]">{t('sharing.selectTeamToAdd')}</p>
                    {filteredTeams.length === 0 ? (
                      <p className="py-2 text-[12.5px] text-[var(--fg-2)]">{t('common.noResults')}</p>
                    ) : (
                      <ScrollArea className="max-h-48 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)]">
                        <div className="space-y-0.5 p-1">
                          {filteredTeams.map((team) => (
                            <button
                              key={team.id}
                              type="button"
                              disabled={saving}
                              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[12.5px] text-[var(--fg-0)] hover:bg-[var(--bg-3)] focus:bg-[var(--bg-3)] focus:outline-none disabled:opacity-50"
                              onClick={() => handleAddTeam(team.id)}
                            >
                              <Users className="h-4 w-4 shrink-0 text-[var(--fg-3)]" />
                              <span>{team.name}</span>
                            </button>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                )}
              </div>

              {bookmarkUrl ? (
                <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2">
                  <Link2 className="size-3.5 shrink-0 text-[var(--accent-hi)]" aria-hidden />
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--fg-0)]">{bookmarkUrl}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      void navigator.clipboard.writeText(bookmarkUrl);
                      setCopiedUrl(true);
                      showToast(t('common.copied'), 'success');
                      setTimeout(() => setCopiedUrl(false), 2000);
                    }}
                  >
                    {copiedUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </ModalBody>

        <ModalFoot>
          <Button variant="ghost" type="button" size="md" onClick={onClose}>
            {t('common.close')}
          </Button>
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

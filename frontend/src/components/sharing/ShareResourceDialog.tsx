import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { usePlan } from '../../contexts/PlanContext';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { Separator } from '../ui/separator';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import { useToast } from '../ui/Toast';
import { User, Users, X } from 'lucide-react';
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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('sharing.inviteDescription')}</DialogDescription>
        </DialogHeader>
        <Separator />

        {loading ? (
          <div className="py-8 space-y-4">
            <div className="h-20 rounded-xl bg-surface-low animate-pulse" />
            <div className="h-20 rounded-xl bg-surface-low animate-pulse" />
          </div>
        ) : (
          <div className="space-y-6">
            {error && (
              <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2">
                {error}
              </div>
            )}

            <div>
              <h4 className="typography-label mb-2">{t('sharing.peopleWithAccess')}</h4>
              {!hasShares ? (
                <p className="text-sm text-muted-foreground">{t('sharing.notSharedYet')}</p>
              ) : (
                <ScrollArea className="max-h-32 rounded-xl border border-ghost bg-surface-low p-2">
                  <div className="space-y-1.5">
                    {allowShareToTeams && sharedTeams.map((team) => (
                      <div
                        key={team.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-ghost/50 bg-surface px-2 py-1.5"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="text-sm truncate">{team.name}</span>
                        </div>
                        <Tooltip content={t('sharing.removeAccess')}>
                          <button
                            type="button"
                            onClick={() => handleRemoveTeam(team.id)}
                            disabled={saving}
                            className="p-1 rounded-lg hover:bg-surface-high text-muted-foreground hover:text-foreground transition-colors"
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
                        className="flex items-center justify-between gap-2 rounded-lg border border-ghost/50 bg-surface px-2 py-1.5"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="text-sm truncate">{u.name || u.email}</span>
                          {u.name && (
                            <span className="text-xs text-muted-foreground truncate">({u.email})</span>
                          )}
                        </div>
                        <Tooltip content={t('sharing.removeAccess')}>
                          <button
                            type="button"
                            onClick={() => handleRemoveUser(u.id)}
                            disabled={saving}
                            className="p-1 rounded-lg hover:bg-surface-high text-muted-foreground hover:text-foreground transition-colors"
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

            <Separator />

            <div>
              <h4 className="typography-label mb-3">{t('sharing.addAccess')}</h4>
              {!loading && allUsers.length === 0 && teams.length === 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-500 mb-2" role="status">
                  {t('sharing.noUsersOrTeams')}
                </p>
              )}
              {allowShareToTeams && allowShareToUsers ? (
                <div className="flex gap-2 border-b border-ghost mb-3">
                  <button
                    type="button"
                    onClick={() => setActiveTab('people')}
                    className={cn(
                      'px-3 py-2 text-sm font-medium border-b-2 transition-colors',
                      activeTab === 'people'
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t('sharing.people')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('teams')}
                    className={cn(
                      'px-3 py-2 text-sm font-medium border-b-2 transition-colors',
                      activeTab === 'teams'
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
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
                    />
                    {peopleDropdownOpen && showUserDropdown && (
                      <div
                        className="absolute top-full left-0 right-0 z-10 mt-1 max-h-48 overflow-auto rounded-xl border border-ghost bg-surface-high shadow-glow"
                        role="listbox"
                      >
                        {usersAvailableToAdd.map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            role="option"
                            className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-surface-low focus:bg-surface-low focus:outline-none rounded-lg"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleAddUser(u.id);
                            }}
                          >
                            <span className="font-medium">{u.name || u.email}</span>
                            {u.name && u.email && (
                              <span className="text-xs text-muted-foreground">{u.email}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('sharing.typeToSearchUsers', { count: MIN_CHARS_FOR_USER_DROPDOWN })}
                  </p>
                </div>
              )}

              {allowShareToTeams && (activeTab === 'teams' || !allowShareToUsers) && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{t('sharing.selectTeamToAdd')}</p>
                  {filteredTeams.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">{t('common.noResults')}</p>
                  ) : (
                    <ScrollArea className="max-h-48 rounded-xl border border-ghost bg-surface-low">
                      <div className="p-1 space-y-0.5">
                        {filteredTeams.map((team) => (
                          <button
                            key={team.id}
                            type="button"
                            disabled={saving}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-high focus:bg-surface-high focus:outline-none disabled:opacity-50"
                            onClick={() => handleAddTeam(team.id)}
                          >
                            <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span>{team.name}</span>
                          </button>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <Separator />
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose} className="border-ghost bg-surface">
            {t('common.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

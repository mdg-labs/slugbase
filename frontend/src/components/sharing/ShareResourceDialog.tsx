import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
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
import { Popover, PopoverContent, PopoverAnchor, PopoverTrigger } from '../ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import Button from '../ui/Button';
import Tooltip from '../ui/Tooltip';
import { useToast } from '../ui/Toast';
import { UserPlus, User, Users, X } from 'lucide-react';
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
  const [peoplePopoverOpen, setPeoplePopoverOpen] = useState(false);
  const [teamsPopoverOpen, setTeamsPopoverOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'people' | 'teams'>('people');

  const allowShareToTeams = teams.length > 0;
  const allowShareToUsers = true;

  const fetchResource = useCallback(async () => {
    if (!resourceId || !isOpen) return;
    setLoading(true);
    setError(null);
    try {
      const endpoint = resourceType === 'bookmark' ? `/bookmarks/${resourceId}` : `/folders/${resourceId}`;
      const res = await api.get(endpoint);
      const data = res.data;
      setSharedUsers(data.shared_users ?? []);
      setSharedTeams(data.shared_teams ?? []);
      setResourceData(resourceType === 'folder' ? { name: data.name, icon: data.icon } : null);
    } catch (err: any) {
      console.error('Failed to fetch resource:', err);
      setError(err.response?.data?.error || t('common.error'));
      showToast(t('common.error'), 'error');
    } finally {
      setLoading(false);
    }
  }, [resourceId, resourceType, isOpen, t, showToast]);

  const fetchUsersAndTeams = useCallback(async () => {
    // Users: prefer /users/for-sharing (no admin); fallback to /admin/users on 404/403 or other failure.
    let users: SharedUser[] = [];
    try {
      const res = await api.get('/users/for-sharing');
      users = Array.isArray(res.data) ? res.data : [];
    } catch (e: any) {
      const status = e.response?.status;
      try {
        const adminRes = await api.get('/admin/users');
        const list = Array.isArray(adminRes.data) ? adminRes.data : [];
        users = list.filter((u: SharedUser) => u.id && u.email);
      } catch {
        if (status) console.error('Sharing: users for-sharing failed', status, e.response?.data);
      }
    }
    setAllUsers(users);

    try {
      const teamsRes = await api.get('/teams');
      const list = teamsRes.data;
      setTeams(Array.isArray(list) ? list : list != null ? [list] : []);
    } catch (err: any) {
      console.error('Failed to fetch teams:', err?.response?.status, err?.response?.data);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchResource();
      fetchUsersAndTeams();
    }
  }, [isOpen, fetchResource, fetchUsersAndTeams]);

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
      await fetchResource();
      onSuccess();
      showToast(t('common.success'), 'success');
    } catch (err: any) {
      const msg = err.response?.data?.error || t('common.error');
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
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
    const newUserIds = [...sharedUsers.map((u) => u.id), userId];
    if (newUserIds.includes(userId)) return;
    updateShares(newUserIds, sharedTeams.map((t) => t.id), false);
    setPeoplePopoverOpen(false);
    setEmailInput('');
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
    const newTeamIds = [...sharedTeams.map((t) => t.id), teamId];
    if (newTeamIds.includes(teamId)) return;
    updateShares(sharedUsers.map((u) => u.id), newTeamIds, false);
    setTeamsPopoverOpen(false);
  }

  const filteredUsers = allUsers.filter((u) => {
    if (!emailInput.trim()) return true;
    const q = emailInput.toLowerCase();
    return u.email.toLowerCase().includes(q) || (u.name && u.name.toLowerCase().includes(q));
  });

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
            <div className="h-20 rounded-md bg-muted animate-pulse" />
            <div className="h-20 rounded-md bg-muted animate-pulse" />
          </div>
        ) : (
          <div className="space-y-6">
            {error && (
              <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2">
                {error}
              </div>
            )}

            <div>
              <h4 className="text-sm font-medium mb-2">{t('sharing.peopleWithAccess')}</h4>
              {!hasShares ? (
                <p className="text-sm text-muted-foreground">{t('sharing.notSharedYet')}</p>
              ) : (
                <ScrollArea className="max-h-32 rounded-md border p-2">
                  <div className="space-y-1.5">
                    {allowShareToTeams && sharedTeams.map((team) => (
                      <div
                        key={team.id}
                        className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 bg-muted/50"
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
                            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
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
                        className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 bg-muted/50"
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
                            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
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
              <h4 className="text-sm font-medium mb-3">{t('sharing.addAccess')}</h4>
              {allowShareToTeams && allowShareToUsers ? (
                <div className="flex gap-2 border-b mb-3">
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
                  <div className="flex gap-2">
                    <Input
                      placeholder={t('admin.searchUsers')}
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddUserByEmail();
                        }
                      }}
                      className="flex-1"
                    />
                    <Popover open={peoplePopoverOpen} onOpenChange={setPeoplePopoverOpen}>
                      <PopoverAnchor asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={saving}
                          onClick={() => {
                            if (emailInput.trim()) {
                              handleAddUserByEmail();
                            } else {
                              setPeoplePopoverOpen(true);
                            }
                          }}
                        >
                          <UserPlus className="h-4 w-4" />
                          {t('sharing.add')}
                        </Button>
                      </PopoverAnchor>
                      <PopoverContent className="w-72 p-0" align="start">
                        <Command>
                          <CommandInput
                            placeholder={t('admin.searchUsers')}
                            value={emailInput}
                            onValueChange={setEmailInput}
                          />
                          <CommandList>
                            <CommandEmpty>{t('common.noResults')}</CommandEmpty>
                            <CommandGroup>
                              {filteredUsers
                                .filter((u) => !sharedUsers.some((su) => su.id === u.id))
                                .map((u) => (
                                  <CommandItem
                                    key={u.id}
                                    onSelect={() => handleAddUser(u.id)}
                                    className="flex flex-col items-start gap-0.5"
                                  >
                                    <span className="font-medium">{u.name || u.email}</span>
                                    {u.name && u.email && (
                                      <span className="text-xs text-muted-foreground">{u.email}</span>
                                    )}
                                  </CommandItem>
                                ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('sharing.emailNotAssociated')}</p>
                </div>
              )}

              {allowShareToTeams && (activeTab === 'teams' || !allowShareToUsers) && (
                <Popover open={teamsPopoverOpen} onOpenChange={setTeamsPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      className="w-full justify-start"
                    >
                      <Users className="h-4 w-4 mr-2" />
                      {t('sharing.teams')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-0" align="start">
                    <Command>
                      <CommandInput placeholder={t('admin.searchTeams')} />
                      <CommandList>
                        <CommandEmpty>{t('common.noResults')}</CommandEmpty>
                        <CommandGroup>
                          {filteredTeams.map((team) => (
                            <CommandItem
                              key={team.id}
                              onSelect={() => handleAddTeam(team.id)}
                            >
                              {team.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>
        )}

        <Separator />
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

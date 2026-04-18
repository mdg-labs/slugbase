import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Switch } from './switch';
import { Label } from './label';
import { Input } from './input';
import { ScrollArea } from './scroll-area';
import Button from './Button';
import { Users, User, Search, X, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Team {
  id: string;
  name: string;
  description?: string;
}

interface UserType {
  id: string;
  name: string;
  email: string;
}

export interface SharingValue {
  user_ids: string[];
  team_ids: string[];
  share_all_teams: boolean;
}

interface SharingFieldProps {
  value: SharingValue;
  onChange: (value: SharingValue) => void;
  teams: Team[];
  allowTeamSharing: boolean;
  label?: string;
  disabled?: boolean;
}

function initialsFrom(name: string) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  if (p.length === 1) return p[0]!.slice(0, 2).toUpperCase();
  return (p[0]![0]! + p[1]![0]!).toUpperCase();
}

export function SharingField({
  value,
  onChange,
  teams,
  allowTeamSharing,
  label,
  disabled = false,
}: SharingFieldProps) {
  const { t } = useTranslation();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [allUsers, setAllUsers] = useState<UserType[]>([]);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [teamSearchQuery, setTeamSearchQuery] = useState('');

  useEffect(() => {
    if (popoverOpen || value.user_ids.length > 0) {
      loadUsers();
    }
  }, [popoverOpen, value.user_ids.length]);

  async function loadUsers() {
    try {
      const response = await api.get('/users/for-sharing');
      const users = Array.isArray(response.data) ? response.data : [];
      setAllUsers(users);
    } catch (error) {
      console.error('Failed to load users for sharing:', error);
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

  const selectedTeams = teams.filter((t) => value.team_ids.includes(t.id));
  const selectedUsers = allUsers.filter((u) => value.user_ids.includes(u.id));
  const hasSelected = value.share_all_teams || selectedTeams.length > 0 || selectedUsers.length > 0;

  function handleShareAllTeamsChange(checked: boolean) {
    onChange({
      ...value,
      share_all_teams: checked,
      team_ids: checked ? [] : value.team_ids,
    });
  }

  function toggleTeam(teamId: string) {
    if (value.share_all_teams) return;
    onChange({
      ...value,
      team_ids: value.team_ids.includes(teamId)
        ? value.team_ids.filter((id) => id !== teamId)
        : [...value.team_ids, teamId],
    });
  }

  function toggleUser(userId: string) {
    onChange({
      ...value,
      user_ids: value.user_ids.includes(userId)
        ? value.user_ids.filter((id) => id !== userId)
        : [...value.user_ids, userId],
    });
  }

  function removeTeam(teamId: string) {
    onChange({
      ...value,
      team_ids: value.team_ids.filter((id) => id !== teamId),
    });
  }

  function removeUser(userId: string) {
    onChange({
      ...value,
      user_ids: value.user_ids.filter((id) => id !== userId),
    });
  }

  return (
    <div className="space-y-3">
      {label && <Label>{label}</Label>}

      {allowTeamSharing && (
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-3">
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium text-[var(--fg-0)]">{t('bookmarks.shareAllTeams')}</p>
            <p className="text-[11px] text-[var(--fg-2)]">{t('bookmarks.shareAllTeamsDescription')}</p>
          </div>
          <Switch
            checked={value.share_all_teams}
            onCheckedChange={handleShareAllTeamsChange}
            disabled={disabled}
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        {value.share_all_teams && (
          <div className="flex items-center gap-2.5 rounded-md border border-[var(--border-soft)] px-2.5 py-2">
            <span className="avatar flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent-bg)] text-[10px] font-semibold text-[var(--accent-hi)] ring-1 ring-[var(--accent-ring)]">
              <Users className="size-3.5" strokeWidth={1.75} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-[var(--fg-0)]">{t('bookmarks.shareAllTeams')}</div>
              <div className="text-[10.5px] text-[var(--fg-3)]">{t('common.teams')}</div>
            </div>
          </div>
        )}
        {selectedTeams.map((team) => (
          <div
            key={team.id}
            className="flex items-center gap-2.5 rounded-md border border-[var(--border-soft)] px-2.5 py-2"
          >
            <span className="avatar flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--bg-3)] font-mono text-[10px] font-medium text-[var(--fg-0)]">
              {initialsFrom(team.name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-[var(--fg-0)]">{team.name}</div>
              <div className="text-[10.5px] text-[var(--fg-3)]">{t('common.team')}</div>
            </div>
            <button
              type="button"
              onClick={() => removeTeam(team.id)}
              disabled={disabled}
              className="rounded p-1 text-[var(--fg-3)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
              aria-label={t('common.remove')}
            >
              <X className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
        ))}
        {selectedUsers.map((u) => (
          <div
            key={u.id}
            className="flex items-center gap-2.5 rounded-md border border-[var(--border-soft)] px-2.5 py-2"
          >
            <span className="avatar flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--bg-3)] font-mono text-[10px] font-medium text-[var(--fg-0)]">
              {initialsFrom(u.name || u.email)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium text-[var(--fg-0)]">{u.name}</div>
              <div className="truncate text-[10.5px] text-[var(--fg-3)]">{u.email}</div>
            </div>
            <button
              type="button"
              onClick={() => removeUser(u.id)}
              disabled={disabled}
              className="rounded p-1 text-[var(--fg-3)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
              aria-label={t('common.remove')}
            >
              <X className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
        ))}
      </div>

      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} className="h-8">
            <UserPlus className="h-4 w-4" />
            {hasSelected
              ? value.share_all_teams
                ? t('bookmarks.shareAllTeams')
                : t('bookmarks.sharingSummary', {
                    teamCount: selectedTeams.length,
                    teams: selectedTeams.length === 1 ? t('common.team') : t('common.teams'),
                    userCount: selectedUsers.length,
                    users: selectedUsers.length === 1 ? t('common.user') : t('common.users'),
                  })
              : t('bookmarks.shareWithTeams')}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-80 max-h-[400px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-2)] p-0 shadow-[var(--shadow-lg)]"
          align="start"
        >
          <div className="space-y-3 p-2">
            {allowTeamSharing && !value.share_all_teams && (
              <>
                <div>
                  <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--fg-3)]">
                    <Users className="h-3.5 w-3.5" />
                    {t('bookmarks.shareWithTeams')}
                  </p>
                  <Input
                    placeholder={t('admin.searchTeams')}
                    value={teamSearchQuery}
                    onChange={(e) => setTeamSearchQuery(e.target.value)}
                    leftSlot={<Search className="text-[var(--fg-3)]" />}
                    className="mb-2 h-8"
                  />
                  <ScrollArea className="max-h-32">
                    <div className="flex flex-wrap gap-1.5">
                      {filteredTeams.map((team) => (
                        <button
                          key={team.id}
                          type="button"
                          onClick={() => toggleTeam(team.id)}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-[7px] text-[13px] transition-colors',
                            value.team_ids.includes(team.id)
                              ? 'bg-[var(--accent-bg)] text-[var(--fg-0)]'
                              : 'text-[var(--fg-0)] hover:bg-[var(--accent-bg)]'
                          )}
                        >
                          {team.name}
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </>
            )}

            <div>
              <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--fg-3)]">
                <User className="h-3.5 w-3.5" />
                {t('bookmarks.shareWithUsers')}
              </p>
              <Input
                placeholder={t('admin.searchUsers')}
                value={userSearchQuery}
                onChange={(e) => setUserSearchQuery(e.target.value)}
                leftSlot={<Search className="text-[var(--fg-3)]" />}
                className="mb-2 h-8"
              />
              <ScrollArea className="max-h-32">
                <div className="flex flex-col gap-0.5">
                  {filteredUsers
                    .filter((u) => !value.user_ids.includes(u.id))
                    .map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => toggleUser(u.id)}
                        className="flex w-full items-center justify-between gap-2 rounded-[6px] px-2.5 py-[7px] text-left text-[13px] text-[var(--fg-0)] transition-colors hover:bg-[var(--accent-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                      >
                        <div className="min-w-0">
                          <p className="font-medium">{u.name}</p>
                          <p className="text-[11px] text-[var(--fg-3)]">{u.email}</p>
                        </div>
                        <UserPlus className="h-3.5 w-3.5 shrink-0 text-[var(--fg-2)]" />
                      </button>
                    ))}
                </div>
              </ScrollArea>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

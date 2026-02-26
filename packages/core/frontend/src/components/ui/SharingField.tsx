import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Switch } from './switch';
import { Label } from './label';
import { Badge } from './badge';
import { Input } from './input';
import { ScrollArea } from './scroll-area';
import Button from './Button';
import { Users, User, Search, X, Check, UserPlus } from 'lucide-react';
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
      // Use non-admin endpoint so any user can add people when sharing (same org/tenant).
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
      {label && (
        <Label className="text-sm font-medium">{label}</Label>
      )}

      {allowTeamSharing && (
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">{t('bookmarks.shareAllTeams')}</p>
            <p className="text-xs text-muted-foreground">
              {t('bookmarks.shareAllTeamsDescription')}
            </p>
          </div>
          <Switch
            checked={value.share_all_teams}
            onCheckedChange={handleShareAllTeamsChange}
            disabled={disabled}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {value.share_all_teams && (
          <Badge variant="secondary">All teams</Badge>
        )}
        {selectedTeams.map((team) => (
          <Badge
            key={team.id}
            variant="secondary"
            className="pr-1 gap-1.5"
          >
            {team.name}
            <button
              type="button"
              onClick={() => removeTeam(team.id)}
              disabled={disabled}
              className="rounded-full hover:bg-secondary/80 p-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('common.remove')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Badge>
        ))}
        {selectedUsers.map((u) => (
          <Badge
            key={u.id}
            variant="secondary"
            className="pr-1 gap-1.5"
          >
            {u.name}
            <button
              type="button"
              onClick={() => removeUser(u.id)}
              disabled={disabled}
              className="rounded-full hover:bg-secondary/80 p-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('common.remove')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Badge>
        ))}
      </div>

      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="h-8"
          >
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
        <PopoverContent className="w-80 max-h-[400px] p-0" align="start">
          <div className="p-2 space-y-3">
            {allowTeamSharing && !value.share_all_teams && (
              <>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" />
                    {t('bookmarks.shareWithTeams')}
                  </p>
                  <div className="relative mb-2">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder={t('admin.searchTeams')}
                      value={teamSearchQuery}
                      onChange={(e) => setTeamSearchQuery(e.target.value)}
                      className="pl-8 h-8"
                    />
                  </div>
                  <ScrollArea className="max-h-32">
                    <div className="flex flex-wrap gap-1.5">
                      {filteredTeams.map((team) => (
                        <button
                          key={team.id}
                          type="button"
                          onClick={() => toggleTeam(team.id)}
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors",
                            value.team_ids.includes(team.id)
                              ? "bg-primary text-primary-foreground"
                              : "bg-secondary hover:bg-secondary/80"
                          )}
                        >
                          {value.team_ids.includes(team.id) && <Check className="h-3 w-3" />}
                          {team.name}
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </>
            )}

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" />
                {t('bookmarks.shareWithUsers')}
              </p>
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder={t('admin.searchUsers')}
                  value={userSearchQuery}
                  onChange={(e) => setUserSearchQuery(e.target.value)}
                  className="pl-8 h-8"
                />
              </div>
              <ScrollArea className="max-h-32">
                <div className="space-y-1">
                  {filteredUsers
                    .filter((u) => !value.user_ids.includes(u.id))
                    .map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => toggleUser(u.id)}
                        className="w-full flex items-center justify-between px-2 py-1.5 rounded text-sm hover:bg-accent text-left"
                      >
                        <div>
                          <p className="font-medium">{u.name}</p>
                          <p className="text-xs text-muted-foreground">{u.email}</p>
                        </div>
                        <UserPlus className="h-3.5 w-3.5" />
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

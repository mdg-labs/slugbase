import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Users, Network, MoreHorizontal } from 'lucide-react';
import TeamModal from '../modals/TeamModal';
import TeamAssignmentModal from '../modals/TeamAssignmentModal';
import Button from '../ui/Button';
import { Skeleton } from '../ui/skeleton';
import { PageHeader } from '../PageHeader';
import { EmptyState } from '../EmptyState';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Card } from '../ui/card';
import { adminTableCardClass } from './adminTableTokens';
import { cn } from '@/lib/utils';

interface Team {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  member_count?: number | string;
  members?: Array<{ id: string; name: string; email: string }>;
}

function formatShortDate(iso?: string) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}

function memberCount(team: Team): number {
  const raw = team.member_count;
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : 0;
}

function teamAccent(name: string): { hue: number } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return { hue: Math.abs(h) % 360 };
}

export default function AdminTeams() {
  const { t } = useTranslation();
  const { showConfirm, dialogState } = useConfirmDialog();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [assignmentModalOpen, setAssignmentModalOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [selectedTeamForAssignment, setSelectedTeamForAssignment] = useState<Team | null>(null);

  useEffect(() => {
    loadTeams();
  }, []);

  const loadTeams = async () => {
    try {
      const response = await api.get('/admin/teams');
      setTeams(response.data);
    } catch (error) {
      console.error('Failed to load teams:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (team: Team) => {
    setEditingTeam(team);
    setModalOpen(true);
  };

  const handleManageMembers = (team: Team) => {
    setSelectedTeamForAssignment(team);
    setAssignmentModalOpen(true);
  };

  const handleDelete = (id: string) => {
    showConfirm(
      t('admin.confirmDeleteTeam'),
      t('admin.confirmDeleteTeam'),
      async () => {
        try {
          await api.delete(`/admin/teams/${id}`);
          loadTeams();
        } catch (error: any) {
          alert(error.response?.data?.error || t('common.error'));
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  };

  const handleModalClose = () => {
    setModalOpen(false);
    setEditingTeam(null);
  };

  const handleAssignmentModalClose = () => {
    setAssignmentModalOpen(false);
    setSelectedTeamForAssignment(null);
  };

  const countSubtitle = `${teams.length} ${teams.length === 1 ? t('common.team') : t('common.teams')}`;

  if (loading) {
    return (
      <div className="space-y-6 pb-24">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Card className={adminTableCardClass}>
          <div className="p-6 space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title={t('admin.teams')}
        subtitle={countSubtitle}
        actions={
          <Button
            onClick={() => setModalOpen(true)}
            icon={Plus}
            className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
          >
            {t('admin.addTeam')}
          </Button>
        }
      />

      {teams.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t('admin.noTeamsYet')}
          description={t('admin.teamsEmptyDescription')}
          action={
            <Button
              onClick={() => setModalOpen(true)}
              variant="primary"
              icon={Plus}
              className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
            >
              {t('admin.addTeam')}
            </Button>
          }
        />
      ) : (
        <div className="folder-grid grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {teams.map((team) => {
            const { hue } = teamAccent(team.name);
            const mc = memberCount(team);
            return (
              <Card
                key={team.id}
                className={cn(
                  adminTableCardClass,
                  'folder-card flex flex-col gap-4 p-4 transition-colors hover:border-[var(--border-strong)]',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div
                    className="f-ico flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] border border-[var(--border)]"
                    style={{
                      background: `linear-gradient(135deg, hsl(${hue} 42% 24% / 0.9), hsl(${hue} 38% 16% / 0.95))`,
                      color: `hsl(${hue} 72% 68%)`,
                    }}
                    aria-hidden
                  >
                    <Users className="h-4 w-4" strokeWidth={1.75} />
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">{t('common.actions')}</span>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleManageMembers(team)}>
                        <Network className="mr-2 h-4 w-4" />
                        {t('admin.manageMembers')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleEdit(team)}>
                        <Edit className="mr-2 h-4 w-4" />
                        {t('common.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleDelete(team.id)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t('common.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div className="min-w-0 space-y-1">
                  <h3 className="truncate text-[14px] font-semibold text-[var(--fg-0)]">{team.name}</h3>
                  <p className="line-clamp-2 min-h-[2.5rem] text-[12.5px] leading-snug text-[var(--fg-2)]">
                    {team.description?.trim() ? team.description : '—'}
                  </p>
                </div>

                <div className="grid grid-cols-3 gap-2 border-t border-[var(--border-soft)] pt-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-[var(--fg-3)]">
                      {t('admin.members')}
                    </p>
                    <p className="tabular-nums text-[13px] text-[var(--fg-0)]">{mc}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-[var(--fg-3)]">
                      {t('folders.title')}
                    </p>
                    <p className="tabular-nums text-[13px] text-[var(--fg-3)]">—</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-[var(--fg-3)]">
                      {t('bookmarks.title')}
                    </p>
                    <p className="tabular-nums text-[13px] text-[var(--fg-3)]">—</p>
                  </div>
                </div>

                <p className="text-[11px] text-[var(--fg-3)]">
                  {t('profile.createdAt')}: {formatShortDate(team.created_at)}
                </p>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-auto w-full"
                  onClick={() => handleManageMembers(team)}
                >
                  {t('admin.manageMembers')}
                </Button>
              </Card>
            );
          })}
        </div>
      )}

      <TeamModal
        team={editingTeam}
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSuccess={loadTeams}
      />

      {selectedTeamForAssignment && (
        <TeamAssignmentModal
          mode="team"
          teamId={selectedTeamForAssignment.id}
          teamName={selectedTeamForAssignment.name}
          isOpen={assignmentModalOpen}
          onClose={handleAssignmentModalClose}
          onSuccess={loadTeams}
        />
      )}

      <ConfirmDialog {...dialogState} />
    </div>
  );
}

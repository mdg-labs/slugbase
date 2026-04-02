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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Card } from '../ui/card';
import {
  adminTableBodyRowClass,
  adminTableCardClass,
  adminTableCellClass,
  adminTableHeadClass,
  adminTableHeaderRowClass,
} from './adminTableTokens';

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
        <Card className={adminTableCardClass}>
          <Table>
            <TableHeader>
              <TableRow className={adminTableHeaderRowClass}>
                <TableHead className={adminTableHeadClass}>{t('admin.teamName')}</TableHead>
                <TableHead className={`${adminTableHeadClass} hidden md:table-cell`}>
                  {t('admin.description')}
                </TableHead>
                <TableHead className={`${adminTableHeadClass} w-[100px]`}>{t('admin.members')}</TableHead>
                <TableHead className={`${adminTableHeadClass} hidden sm:table-cell w-[140px]`}>
                  {t('profile.createdAt')}
                </TableHead>
                <TableHead className={`${adminTableHeadClass} w-[88px] text-right`}>
                  {t('common.actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((team) => (
                <TableRow key={team.id} className={adminTableBodyRowClass}>
                  <TableCell className={adminTableCellClass}>
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-gradient-to-br from-primary/15 to-primary/25">
                        <Users className="h-4 w-4 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">{team.name}</p>
                        {team.description ? (
                          <p className="text-sm text-muted-foreground truncate md:hidden">{team.description}</p>
                        ) : null}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className={`${adminTableCellClass} hidden md:table-cell max-w-xs`}>
                    <span className="text-sm text-muted-foreground line-clamp-2">
                      {team.description || '—'}
                    </span>
                  </TableCell>
                  <TableCell className={`${adminTableCellClass} tabular-nums text-muted-foreground`}>
                    {memberCount(team)}
                  </TableCell>
                  <TableCell className={`${adminTableCellClass} hidden sm:table-cell text-muted-foreground`}>
                    {formatShortDate(team.created_at)}
                  </TableCell>
                  <TableCell className={`${adminTableCellClass} text-right`}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-high hover:text-foreground"
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
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

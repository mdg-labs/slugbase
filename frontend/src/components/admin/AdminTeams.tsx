import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Users, Network } from 'lucide-react';
import TeamModal from '../modals/TeamModal';
import TeamAssignmentModal from '../modals/TeamAssignmentModal';
import Button from '../ui/Button';
import { PageLoadingSkeleton } from '../ui/PageLoadingSkeleton';

interface Team {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  members?: Array<{ id: string; name: string; email: string }>;
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

  if (loading) {
    return <PageLoadingSkeleton lines={6} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('admin.teams')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {teams.length} {teams.length === 1 ? 'team' : 'teams'}
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)} icon={Plus} className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90">
          {t('admin.addTeam')}
        </Button>
      </div>

      {teams.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-ghost bg-surface py-16 px-4">
          <Users className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground text-lg mb-4">{t('admin.noTeamsYet')}</p>
          <Button onClick={() => setModalOpen(true)} variant="primary" size="sm" icon={Plus} className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90">
            {t('admin.addTeam')}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <div
              key={team.id}
              className="group overflow-hidden rounded-xl border border-ghost bg-surface shadow-none transition-colors hover:border-primary/25"
            >
              <div className="p-4 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Users className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <h3 className="text-lg font-semibold text-foreground truncate">
                      {team.name}
                    </h3>
                  </div>
                </div>
                {team.description && (
                  <p className="text-sm text-muted-foreground">{team.description}</p>
                )}
                <div className="flex gap-2 pt-2 border-t border-ghost">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Network}
                    onClick={() => handleManageMembers(team)}
                    className="flex-1"
                    title={t('admin.manageMembers')}
                  >
                    {t('admin.members')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Edit}
                    onClick={() => handleEdit(team)}
                  />
                  <Button
                    variant="danger"
                    size="sm"
                    icon={Trash2}
                    onClick={() => handleDelete(team.id)}
                  />
                </div>
              </div>
            </div>
          ))}
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

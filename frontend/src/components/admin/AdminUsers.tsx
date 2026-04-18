import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { Plus, Edit, Trash2, Shield, Network, MoreHorizontal, RotateCw } from 'lucide-react';
import UserModal from '../modals/UserModal';
import TeamAssignmentModal from '../modals/TeamAssignmentModal';
import Button from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { PageHeader } from '../PageHeader';
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
import { Skeleton } from '../ui/skeleton';
import {
  adminTableBodyRowClass,
  adminTableCardClass,
  adminTableCellClass,
  adminTableHeadClass,
  adminTableHeaderRowClass,
} from './adminTableTokens';
import {
  usePlan,
  usePlanLoadState,
  canInviteOrgUsers,
  showAdminTeamsNav,
  isCloudMode,
} from '../../contexts/PlanContext';
import { useToast } from '../ui/Toast';
import { Badge } from '../ui/badge';

interface User {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
  oidc_provider: string | null;
  created_at: string;
  invite_pending?: boolean;
  invite_expires_at?: string | null;
  invite_expired?: boolean;
}

function formatInviteDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function userInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

export default function AdminUsers() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const canAddUsers = canInviteOrgUsers(planInfo, planLoadState);
  const showTeamAssignment = showAdminTeamsNav(planInfo, planLoadState);
  const { showConfirm, dialogState } = useConfirmDialog();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [assignmentModalOpen, setAssignmentModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [selectedUserForAssignment, setSelectedUserForAssignment] = useState<User | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const response = await api.get('/admin/users');
      setUsers(response.data);
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (user: User) => {
    setEditingUser(user);
    setModalOpen(true);
  };

  const handleManageTeams = (user: User) => {
    setSelectedUserForAssignment(user);
    setAssignmentModalOpen(true);
  };

  const handleResendInvite = async (userId: string) => {
    setResendingId(userId);
    try {
      await api.post(`/admin/users/${userId}/resend-invite`);
      showToast(t('admin.inviteResent'), 'success');
      await loadUsers();
    } catch (error: any) {
      showToast(error.response?.data?.error || t('common.error'), 'error');
    } finally {
      setResendingId(null);
    }
  };

  const handleDelete = (id: string) => {
    showConfirm(
      t('admin.confirmDeleteUser'),
      t('admin.confirmDeleteUser'),
      async () => {
        try {
          await api.delete(`/admin/users/${id}`);
          loadUsers();
        } catch (error: any) {
          alert(error.response?.data?.error || t('common.error'));
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  };

  const handleModalClose = () => {
    setModalOpen(false);
    setEditingUser(null);
  };

  const handleAssignmentModalClose = () => {
    setAssignmentModalOpen(false);
    setSelectedUserForAssignment(null);
  };

  const countSubtitle = `${users.length} ${users.length === 1 ? t('common.user') : t('common.users')}`;

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
        title={t('admin.users')}
        subtitle={countSubtitle}
        actions={
          canAddUsers ? (
            <Button
              onClick={() => setModalOpen(true)}
              icon={Plus}
              className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
            >
              {t('admin.addUser')}
            </Button>
          ) : isCloudMode && planLoadState === 'ready' && !canAddUsers ? (
            <p className="max-w-md text-sm text-muted-foreground">{t('admin.billingUpgradeToInvite')}</p>
          ) : null
        }
      />

      <Card className={adminTableCardClass}>
        <Table>
          <TableHeader>
            <TableRow className={adminTableHeaderRowClass}>
              <TableHead className={`${adminTableHeadClass} w-[52px]`}>
                <span className="sr-only">{t('admin.user')}</span>
              </TableHead>
              <TableHead className={adminTableHeadClass}>{t('admin.user')}</TableHead>
              <TableHead className={`${adminTableHeadClass} hidden sm:table-cell`}>
                {t('auth.email')}
              </TableHead>
              <TableHead className={`${adminTableHeadClass} w-[88px] text-right`}>
                {t('common.actions')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id} className={adminTableBodyRowClass}>
                <TableCell className={adminTableCellClass}>
                  <div
                    className="avatar flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--accent-bg)] font-mono text-[12px] font-semibold text-[var(--accent-hi)]"
                    aria-hidden
                  >
                    {userInitials(user.name || user.email)}
                  </div>
                </TableCell>
                <TableCell className={adminTableCellClass}>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">{user.name}</p>
                    {Boolean(user.is_admin) && (
                      <span title={t('admin.admin')}>
                        <Shield className="h-4 w-4 text-yellow-500" />
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground truncate sm:hidden">{user.email}</p>
                  {user.oidc_provider && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('admin.oidcUser')}: {user.oidc_provider}
                    </p>
                  )}
                  {user.invite_pending && (
                    <div className="mt-1.5 space-y-1">
                      <Badge
                        variant="secondary"
                        className={
                          user.invite_expired
                            ? 'bg-[rgba(248,113,113,0.12)] text-[var(--danger)] border-[rgba(248,113,113,0.35)]'
                            : 'border-[var(--border)] bg-[var(--accent-bg)] text-[var(--accent-hi)]'
                        }
                      >
                        {user.invite_expired ? t('admin.inviteExpired') : t('admin.invitePending')}
                      </Badge>
                      {user.invite_expires_at && !user.invite_expired && (
                        <p className="text-xs text-muted-foreground">
                          {t('admin.inviteLinkExpires', { date: formatInviteDate(user.invite_expires_at) })}
                        </p>
                      )}
                      {user.invite_expires_at && user.invite_expired && (
                        <p className="text-xs text-muted-foreground">
                          {t('admin.inviteExpiredOn', { date: formatInviteDate(user.invite_expires_at) })}
                        </p>
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell className={`${adminTableCellClass} hidden sm:table-cell text-muted-foreground`}>
                  {user.email}
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
                      {showTeamAssignment && (
                        <DropdownMenuItem onClick={() => handleManageTeams(user)}>
                          <Network className="mr-2 h-4 w-4" />
                          {t('admin.manageTeams')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => handleEdit(user)}>
                        <Edit className="mr-2 h-4 w-4" />
                        {t('common.edit')}
                      </DropdownMenuItem>
                      {user.invite_pending && user.invite_expired && (
                        <DropdownMenuItem
                          onClick={() => handleResendInvite(user.id)}
                          disabled={resendingId === user.id}
                        >
                          <RotateCw className="mr-2 h-4 w-4" />
                          {resendingId === user.id ? t('common.loading') : t('admin.resendInvite')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => handleDelete(user.id)}
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

      <UserModal
        user={editingUser}
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSuccess={loadUsers}
      />

      {selectedUserForAssignment && (
        <TeamAssignmentModal
          mode="user"
          userId={selectedUserForAssignment.id}
          userName={selectedUserForAssignment.name}
          isOpen={assignmentModalOpen}
          onClose={handleAssignmentModalClose}
          onSuccess={loadUsers}
        />
      )}

      <ConfirmDialog {...dialogState} />
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield } from 'lucide-react';
import api from '../../api/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Separator } from '../ui/separator';
import { FormFieldWrapper } from '../ui/FormFieldWrapper';
import { ModalSection } from '../ui/ModalSection';
import { ModalFooterActions } from '../ui/ModalFooterActions';
import Button from '../ui/Button';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import {
  isCloudMode,
  usePlan,
  usePlanLoadState,
  canInviteOrgUsers,
} from '../../contexts/PlanContext';

interface User {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
  oidc_provider: string | null;
}

interface UserModalProps {
  user: User | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type CreateMode = 'set_password' | 'send_invite';

export default function UserModal({ user, isOpen, onClose, onSuccess }: UserModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { user: currentUser } = useAuth();
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const canSetInstanceAdmin = !!currentUser?.is_admin;
  const [formData, setFormData] = useState({
    email: '',
    name: '',
    password: '',
    is_admin: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inviteEnabled, setInviteEnabled] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>('set_password');

  const isCreate = !user;
  const inviteChoiceAvailable = isCloudMode
    ? planLoadState === 'ready' && planInfo?.emailInvitesAvailable === true
    : inviteEnabled;

  useEffect(() => {
    if (user) {
      setFormData({
        email: user.email,
        name: user.name,
        password: '',
        is_admin: user.is_admin,
      });
    } else {
      setFormData({ email: '', name: '', password: '', is_admin: false });
      setCreateMode('set_password');
    }
    setError('');
  }, [user, isOpen]);

  useEffect(() => {
    if (isCreate && createMode === 'send_invite' && !inviteChoiceAvailable) {
      setCreateMode('set_password');
    }
  }, [isCreate, createMode, inviteChoiceAvailable]);

  useEffect(() => {
    if (!user && isOpen && !isCloudMode) {
      api
        .get('/admin/settings')
        .then((res) => {
          setInviteEnabled(res.data?.smtp_enabled === 'true');
        })
        .catch(() => setInviteEnabled(false));
    }
    if (!user && isOpen && isCloudMode) {
      setInviteEnabled(false);
    }
  }, [user, isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isCreate && isCloudMode && !canInviteOrgUsers(planInfo, planLoadState)) {
      return;
    }
    setLoading(true);
    setError('');

    try {
      const payload: any = { email: formData.email, name: formData.name };
      if (canSetInstanceAdmin) {
        payload.is_admin = formData.is_admin;
      } else {
        payload.is_admin = false;
      }
      if (user) {
        if (formData.password) payload.password = formData.password;
        if (!canSetInstanceAdmin) {
          delete payload.is_admin;
        }
        await api.put(`/admin/users/${user.id}`, payload);
        showToast(t('common.success'), 'success');
      } else {
        if (createMode === 'send_invite') {
          payload.send_invite = true;
        } else if (formData.password) {
          payload.password = formData.password;
        }
        const response = await api.post('/admin/users', payload);
        if (payload.send_invite && response.data?.inviteSent === false) {
          showToast(t('admin.userCreatedInviteNotSent'), 'warning');
        } else if (payload.send_invite && response.data?.inviteSent === true) {
          showToast(t('admin.userCreatedInviteSent'), 'success');
        } else {
          showToast(t('common.success'), 'success');
        }
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || t('common.error'));
    } finally {
      setLoading(false);
    }
  }

  const useInvite = isCreate && inviteChoiceAvailable && createMode === 'send_invite';
  const isValid =
    formData.email.trim() &&
    formData.name.trim() &&
    (user ? true : useInvite ? true : formData.password.length >= 8);

  const createBlockedByPlan =
    isCreate && isCloudMode && planLoadState === 'ready' && !canInviteOrgUsers(planInfo, planLoadState);
  const createPlanLoading = isCreate && isCloudMode && planLoadState === 'loading';

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{user ? t('admin.editUser') : t('admin.addUser')}</DialogTitle>
        </DialogHeader>
        <Separator />

        {createPlanLoading ? (
          <p className="py-6 text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : createBlockedByPlan ? (
          <p className="py-2 text-sm text-muted-foreground">{t('admin.billingUpgradeToInvite')}</p>
        ) : null}

        {!createPlanLoading && !createBlockedByPlan ? (
        <form id="user-form" onSubmit={handleSubmit} className="space-y-6">
          <ModalSection>
            <FormFieldWrapper label={t('auth.email')} required error={error}>
              <Input
                type="email"
                required
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder={t('auth.email')}
              />
            </FormFieldWrapper>
            <FormFieldWrapper label={t('setup.name')} required>
              <Input
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('setup.name')}
              />
            </FormFieldWrapper>
            {isCreate && inviteChoiceAvailable && (
              <div className="space-y-3">
                <Label className="text-sm font-medium">{t('admin.createUserWith')}</Label>
                <div className="flex flex-col gap-2" role="radiogroup" aria-label="Create user with">
                  <div className="flex items-center space-x-2">
                    <input
                      type="radio"
                      id="create-set-password"
                      name="create-mode"
                      value="set_password"
                      checked={createMode === 'set_password'}
                      onChange={() => setCreateMode('set_password')}
                      className="h-4 w-4 rounded-full border-input"
                    />
                    <Label htmlFor="create-set-password" className="font-normal cursor-pointer">
                      {t('admin.setPassword')}
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      type="radio"
                      id="create-send-invite"
                      name="create-mode"
                      value="send_invite"
                      checked={createMode === 'send_invite'}
                      onChange={() => setCreateMode('send_invite')}
                      className="h-4 w-4 rounded-full border-input"
                    />
                    <Label htmlFor="create-send-invite" className="font-normal cursor-pointer">
                      {t('admin.sendInviteEmail')}
                    </Label>
                  </div>
                </div>
              </div>
            )}
            {!useInvite && (
              <FormFieldWrapper
                label={user ? `${t('auth.password')} (${t('admin.leaveBlank')})` : t('auth.password')}
                required={!user}
              >
                <Input
                  type="password"
                  minLength={8}
                  required={!user}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder={user ? t('admin.leaveBlank') : ''}
                />
              </FormFieldWrapper>
            )}
            {canSetInstanceAdmin && (
              <div className="flex items-center justify-between rounded-lg border p-3">
                <Label htmlFor="is_admin" className="text-sm font-medium cursor-pointer flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  {t('admin.admin')}
                </Label>
                <Switch
                  id="is_admin"
                  checked={formData.is_admin}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_admin: checked })}
                />
              </div>
            )}
          </ModalSection>
        </form>
        ) : null}

        <Separator />
        <DialogFooter className="flex-row justify-between sm:justify-end gap-2">
          {createPlanLoading || createBlockedByPlan ? (
            <Button variant="outline" onClick={onClose} type="button">
              {t('common.cancel')}
            </Button>
          ) : (
            <ModalFooterActions
              onCancel={onClose}
              submitLabel={t('common.save')}
              loading={loading}
              submitDisabled={!isValid}
              formId="user-form"
            />
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

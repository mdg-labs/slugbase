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
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';

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

export default function UserModal({ user, isOpen, onClose, onSuccess }: UserModalProps) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    email: '',
    name: '',
    password: '',
    is_admin: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
    }
    setError('');
  }, [user, isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const payload: any = { ...formData };
      if (!payload.password) {
        delete payload.password;
      }

      if (user) {
        await api.put(`/admin/users/${user.id}`, payload);
      } else {
        await api.post('/admin/users', payload);
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || t('common.error'));
    } finally {
      setLoading(false);
    }
  }

  const isValid = formData.email.trim() && formData.name.trim() && (user ? true : formData.password.length >= 8);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{user ? t('admin.editUser') : t('admin.addUser')}</DialogTitle>
        </DialogHeader>
        <Separator />

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
          </ModalSection>
        </form>

        <Separator />
        <DialogFooter className="flex-row justify-between sm:justify-end gap-2">
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            loading={loading}
            submitDisabled={!isValid}
            formId="user-form"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
import { Input } from '../ui/input';

interface Team {
  id: string;
  name: string;
  description: string | null;
}

interface TeamModalProps {
  team: Team | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TeamModal({ team, isOpen, onClose, onSuccess }: TeamModalProps) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    name: '',
    description: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (team) {
      setFormData({
        name: team.name,
        description: team.description || '',
      });
    } else {
      setFormData({ name: '', description: '' });
    }
    setError('');
  }, [team, isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (team) {
        await api.put(`/admin/teams/${team.id}`, formData);
      } else {
        await api.post('/admin/teams', formData);
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || t('common.error'));
    } finally {
      setLoading(false);
    }
  }

  const isValid = formData.name.trim();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{team ? t('admin.editTeam') : t('admin.addTeam')}</DialogTitle>
        </DialogHeader>
        <Separator />

        <form id="team-form" onSubmit={handleSubmit} className="space-y-6">
          <ModalSection>
            <FormFieldWrapper label={t('admin.teamName')} required error={error}>
              <Input
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('admin.teamName')}
              />
            </FormFieldWrapper>
            <FormFieldWrapper label={t('admin.description')}>
              <textarea
                rows={3}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder={t('admin.description')}
              />
            </FormFieldWrapper>
          </ModalSection>
        </form>

        <Separator />
        <DialogFooter className="flex-row justify-between sm:justify-end gap-2">
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            loading={loading}
            submitDisabled={!isValid}
            formId="team-form"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

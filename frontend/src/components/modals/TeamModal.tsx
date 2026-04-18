import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import api from '../../api/client';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
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
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent className="flex max-h-[90vh] max-w-[460px] flex-col p-0">
        <ModalHead icon={Users} title={team ? t('admin.editTeam') : t('admin.addTeam')} />

        <ModalBody>
          <form id="team-form" onSubmit={handleSubmit} className="space-y-6">
            <ModalSection>
              <FormFieldWrapper label={t('admin.teamName')} required error={error}>
                <Input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={t('admin.teamName')}
                  leftSlot={<Users strokeWidth={1.75} aria-hidden />}
                />
              </FormFieldWrapper>
              <FormFieldWrapper label={t('admin.description')}>
                <div className="flex min-h-[4.5rem] w-full items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-2.5 py-1.5 text-[12.5px] transition-colors focus-within:border-[var(--accent-ring)] focus-within:bg-[var(--bg-1)] focus-within:shadow-[0_0_0_3px_var(--accent-bg)]">
                  <textarea
                    rows={3}
                    className="min-h-[3.25rem] w-full resize-none bg-transparent text-[12.5px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-3)]"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder={t('admin.description')}
                  />
                </div>
              </FormFieldWrapper>
            </ModalSection>
          </form>
        </ModalBody>

        <ModalFoot>
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            loading={loading}
            submitDisabled={!isValid}
            formId="team-form"
          />
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

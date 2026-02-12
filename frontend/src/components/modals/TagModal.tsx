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

interface Tag {
  id: string;
  name: string;
}

interface TagModalProps {
  tag: Tag | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TagModal({ tag, isOpen, onClose, onSuccess }: TagModalProps) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({ name: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (tag) {
      setFormData({ name: tag.name });
    } else {
      setFormData({ name: '' });
    }
    setError('');
  }, [tag, isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (tag) {
        await api.put(`/tags/${tag.id}`, formData);
      } else {
        await api.post('/tags', formData);
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{tag ? t('tags.edit') : t('tags.create')}</DialogTitle>
        </DialogHeader>
        <Separator />

        <form id="tag-form" onSubmit={handleSubmit} className="space-y-6">
          <ModalSection>
            <FormFieldWrapper label={t('tags.name')} required error={error}>
              <Input
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData({ name: e.target.value })}
                placeholder={t('tags.name')}
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
            formId="tag-form"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

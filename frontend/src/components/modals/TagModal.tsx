import React, { useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
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
import { Tag } from 'lucide-react';

interface TagData {
  id: string;
  name: string;
  bookmark_count?: number;
}

interface TagModalProps {
  tag: TagData | null;
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
  const bookmarkCount = tag?.bookmark_count;

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent className="flex max-h-[90vh] max-w-[440px] flex-col p-0">
        <ModalHead icon={Tag} title={tag ? t('tags.edit') : t('tags.create')} />

        <ModalBody>
          <form id="tag-form" onSubmit={handleSubmit} className="space-y-6">
            <ModalSection>
              <FormFieldWrapper label={t('tags.name')} required error={error}>
                <Input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ name: e.target.value })}
                  placeholder={t('tags.name')}
                  leftSlot={<Tag strokeWidth={1.75} aria-hidden />}
                />
              </FormFieldWrapper>
            </ModalSection>
          </form>

          {typeof bookmarkCount === 'number' ? (
            <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-3 py-2.5 text-[12.5px] text-[var(--fg-1)]">
              <Trans
                i18nKey="tags.renameInfoStrip"
                values={{ count: bookmarkCount }}
                components={{ strong: <strong className="font-semibold text-[var(--fg-0)]" /> }}
              />
            </div>
          ) : null}
        </ModalBody>

        <ModalFoot>
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            loading={loading}
            submitDisabled={!isValid}
            formId="tag-form"
          />
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

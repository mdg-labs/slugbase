import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
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
import FolderIcon, { popularIcons, getAllIcons } from '../FolderIcon';
import { Folder, Search, X } from 'lucide-react';
import * as LucideIcons from 'lucide-react';

interface Folder {
  id: string;
  name: string;
  icon?: string | null;
  shared_teams?: Array<{ id: string; name: string }>;
  folder_type?: 'own' | 'shared';
}

interface FolderModalProps {
  folder: Folder | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function FolderModal({
  folder,
  isOpen,
  onClose,
  onSuccess,
}: FolderModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [formData, setFormData] = useState({
    name: '',
    icon: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [iconSearchQuery, setIconSearchQuery] = useState('');
  const [showAllIcons, setShowAllIcons] = useState(false);

  const allIcons = useMemo(() => getAllIcons(), []);

  const filteredIcons = useMemo(() => {
    const iconsToSearch = showAllIcons ? allIcons : popularIcons;
    if (!iconSearchQuery.trim()) {
      return iconsToSearch;
    }
    const query = iconSearchQuery.toLowerCase();
    const filtered = iconsToSearch.filter((iconName) =>
      iconName.toLowerCase().includes(query)
    );
    const exactMatch = allIcons.find(icon => icon.toLowerCase() === query);
    if (exactMatch && !filtered.includes(exactMatch)) {
      return [exactMatch, ...filtered];
    }
    return filtered;
  }, [iconSearchQuery, showAllIcons, allIcons]);

  const isValidIconName = useMemo(() => {
    if (!iconSearchQuery.trim()) return false;
    const query = iconSearchQuery.trim();
    return allIcons.some(icon => icon.toLowerCase() === query.toLowerCase());
  }, [iconSearchQuery, allIcons]);

  useEffect(() => {
    if (folder) {
      setFormData({
        name: folder.name,
        icon: folder.icon || '',
      });
    } else {
      setFormData({ name: '', icon: '' });
    }
    setError('');
    setIconSearchQuery('');
    setShowAllIcons(false);
  }, [folder, isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const payload: any = {
        name: formData.name,
        icon: formData.icon || undefined,
      };

      Object.keys(payload).forEach(key => {
        if (payload[key] === undefined) {
          delete payload[key];
        }
      });
      if (folder) {
        await api.put(`/folders/${folder.id}`, payload);
      } else {
        await api.post('/folders', payload);
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || t('common.error');
      const code = err.response?.data?.code;
      setError(errorMessage);
      if (code === 'PLAN_FOLDER_SHARING') {
        showToast(errorMessage, 'error');
      }
    } finally {
      setLoading(false);
    }
  }

  const isValid = formData.name.trim();

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent className="flex max-h-[90vh] max-w-[460px] flex-col p-0">
        <ModalHead icon={Folder} title={folder ? t('folders.edit') : t('folders.create')} />

        <ModalBody>
          <form id="folder-form" onSubmit={handleSubmit} className="space-y-6">
            <ModalSection>
              <FormFieldWrapper label={t('folders.name')} required error={error}>
                <Input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={t('folders.name')}
                  leftSlot={<Folder strokeWidth={1.75} aria-hidden />}
                />
              </FormFieldWrapper>

              <div>
                <label className="mb-2 block text-[12.5px] font-medium text-[var(--fg-0)]">{t('folders.icon')}</label>
                <div className="space-y-2">
                  <div className="relative">
                    <Input
                      type="text"
                      placeholder={t('folders.searchIcons')}
                      value={iconSearchQuery}
                      onChange={(e) => setIconSearchQuery(e.target.value)}
                      leftSlot={<Search className="text-[var(--fg-3)]" strokeWidth={1.75} />}
                      rightSlot={
                        iconSearchQuery ? (
                          <button
                            type="button"
                            onClick={() => setIconSearchQuery('')}
                            className="rounded p-0.5 text-[var(--fg-3)] hover:text-[var(--fg-0)]"
                            aria-label={t('common.remove')}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        ) : null
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-[var(--fg-3)]">
                    <span>
                      {showAllIcons
                        ? t('folders.showingAllIcons', { count: filteredIcons.length })
                        : t('folders.showingPopular', { count: filteredIcons.length })}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAllIcons(!showAllIcons);
                        setIconSearchQuery('');
                      }}
                      className="text-[var(--accent-hi)] hover:underline"
                    >
                      {showAllIcons ? t('folders.showPopularOnly') : t('folders.showAllIcons')}
                    </button>
                  </div>
                </div>

                {isValidIconName && iconSearchQuery.trim() && !filteredIcons.some(icon => icon.toLowerCase() === iconSearchQuery.trim().toLowerCase()) && (
                  <button
                    type="button"
                    onClick={() => {
                      const query = iconSearchQuery.trim();
                      const matchedIcon = allIcons.find(icon => icon.toLowerCase() === query.toLowerCase());
                      if (matchedIcon) {
                        setFormData({ ...formData, icon: matchedIcon });
                        setIconSearchQuery('');
                      }
                    }}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-[12.5px] font-medium text-[var(--fg-0)] transition-colors hover:bg-[var(--bg-3)]"
                  >
                    {t('folders.useIcon')}:{' '}
                    <code className="rounded bg-[var(--bg-1)] px-1.5 py-0.5 font-mono text-[11px]">
                      {allIcons.find(icon => icon.toLowerCase() === iconSearchQuery.trim().toLowerCase())}
                    </code>
                  </button>
                )}

                <div className="mt-2 grid max-h-48 grid-cols-8 gap-2 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] p-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, icon: '' })}
                    className={`rounded-md border-2 p-2 transition-colors ${
                      formData.icon === ''
                        ? 'border-[var(--accent-ring)] bg-[var(--accent-bg)]'
                        : 'border-transparent hover:border-[var(--border-strong)]'
                    }`}
                    title={t('folders.noIcon')}
                  >
                    <FolderIcon iconName={null} size={16} className="mx-auto text-[var(--fg-3)]" />
                  </button>

                  {filteredIcons.length === 0 ? (
                    <div className="col-span-8 py-6 text-center text-[12.5px] text-[var(--fg-2)]">
                      {t('folders.noIconsFound')}
                      {!isValidIconName && iconSearchQuery.trim() && (
                        <p className="mt-2 text-[11px]">{t('folders.typeIconName')}</p>
                      )}
                    </div>
                  ) : (
                    filteredIcons.map((iconName) => {
                      let IconComponent = (LucideIcons as any)[iconName];
                      if (!IconComponent) {
                        const iconNameLower = iconName.toLowerCase();
                        for (const key in LucideIcons) {
                          if (key.toLowerCase() === iconNameLower) {
                            const candidate = (LucideIcons as any)[key];
                            const isVal = typeof candidate === 'function' ||
                              (candidate && typeof candidate === 'object' && (candidate.$$typeof || candidate.render));
                            if (isVal) {
                              IconComponent = candidate;
                              break;
                            }
                          }
                        }
                      }

                      const isValidComponent = IconComponent &&
                        (typeof IconComponent === 'function' ||
                          (typeof IconComponent === 'object' && IconComponent !== null && ((IconComponent as any).$$typeof || (IconComponent as any).render)));

                      if (!isValidComponent) return null;

                      return (
                        <button
                          key={iconName}
                          type="button"
                          onClick={() => setFormData({ ...formData, icon: iconName })}
                          className={`rounded-md border-2 p-2 transition-colors ${
                            formData.icon === iconName
                              ? 'border-[var(--accent-ring)] bg-[var(--accent-bg)]'
                              : 'border-transparent hover:border-[var(--border-strong)]'
                          }`}
                          title={iconName}
                        >
                          <IconComponent className="mx-auto h-4 w-4 text-[var(--fg-2)]" />
                        </button>
                      );
                    })
                  )}
                </div>

                {formData.icon && (
                  <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-2 py-2">
                    <FolderIcon iconName={formData.icon} size={16} className="text-[var(--accent-hi)]" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium text-[var(--fg-0)]">{t('folders.selectedIcon')}</p>
                      <p className="truncate font-mono text-[11px] text-[var(--fg-2)]">{formData.icon}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, icon: '' })}
                      className="text-[var(--fg-3)] hover:text-[var(--fg-0)]"
                      title={t('folders.clearIcon')}
                      aria-label={t('folders.clearIcon')}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </ModalSection>
          </form>
        </ModalBody>

        <ModalFoot>
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            loading={loading}
            submitDisabled={!isValid}
            formId="folder-form"
          />
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

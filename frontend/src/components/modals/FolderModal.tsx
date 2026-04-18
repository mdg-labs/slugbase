import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
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
import FolderIcon, { popularIcons, getAllIcons } from '../FolderIcon';
import { Search, X } from 'lucide-react';
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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{folder ? t('folders.edit') : t('folders.create')}</DialogTitle>
        </DialogHeader>
        <Separator />

        <form id="folder-form" onSubmit={handleSubmit} className="space-y-6">
          <ModalSection>
            <FormFieldWrapper label={t('folders.name')} required error={error}>
              <Input
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('folders.name')}
              />
            </FormFieldWrapper>

            <div>
              <label className="block text-sm font-medium mb-2">{t('folders.icon')}</label>
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="text"
                    placeholder={t('folders.searchIcons')}
                    value={iconSearchQuery}
                    onChange={(e) => setIconSearchQuery(e.target.value)}
                    className="pl-9 pr-9"
                  />
                  {iconSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setIconSearchQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={t('common.remove')}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
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
                    className="text-primary hover:underline"
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
                  className="w-full mt-2 px-3 py-2 text-sm font-medium rounded-xl border border-ghost bg-surface-low hover:bg-surface-high transition-colors flex items-center justify-center gap-2"
                >
                  {t('folders.useIcon')}: <code className="px-1.5 py-0.5 bg-muted rounded">{allIcons.find(icon => icon.toLowerCase() === iconSearchQuery.trim().toLowerCase())}</code>
                </button>
              )}

              <div className="grid grid-cols-8 gap-2 max-h-48 overflow-y-auto p-2 border border-ghost rounded-xl bg-surface-low mt-2">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, icon: '' })}
                  className={`p-2 rounded-lg border-2 transition-colors ${
                    formData.icon === ''
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-muted-foreground/50'
                  }`}
                  title={t('folders.noIcon')}
                >
                  <FolderIcon iconName={null} size={16} className="mx-auto text-muted-foreground" />
                </button>

                {filteredIcons.length === 0 ? (
                  <div className="col-span-8 text-center py-6 text-sm text-muted-foreground">
                    {t('folders.noIconsFound')}
                    {!isValidIconName && iconSearchQuery.trim() && (
                      <p className="mt-2 text-xs">{t('folders.typeIconName')}</p>
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
                          const isValid = typeof candidate === 'function' ||
                            (candidate && typeof candidate === 'object' && (candidate.$$typeof || candidate.render));
                          if (isValid) {
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
                        className={`p-2 rounded-lg border-2 transition-colors ${
                          formData.icon === iconName
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-muted-foreground/50'
                        }`}
                        title={iconName}
                      >
                        <IconComponent className="h-4 w-4 mx-auto text-muted-foreground" />
                      </button>
                    );
                  })
                )}
              </div>

              {formData.icon && (
                <div className="mt-2 flex items-center gap-2 p-2 rounded-lg border bg-muted/50">
                  <FolderIcon iconName={formData.icon} size={16} className="text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium">{t('folders.selectedIcon')}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">{formData.icon}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, icon: '' })}
                    className="text-muted-foreground hover:text-foreground"
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

        <Separator />
        <DialogFooter className="flex-row justify-between sm:justify-end gap-2">
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            loading={loading}
            submitDisabled={!isValid}
            formId="folder-form"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

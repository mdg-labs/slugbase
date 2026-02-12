import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useOrgPlan } from '../../contexts/OrgPlanContext';
import { canShareToTeams } from '../../utils/plan';
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
import { SharingField } from '../ui/SharingField';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import Autocomplete from '../ui/Autocomplete';
import { Copy, Check } from 'lucide-react';
import { useToast } from '../ui/Toast';

interface Bookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
  forwarding_enabled: boolean;
  owner_user_key?: string;
  folder_id?: string;
  tags?: Array<{ id: string; name: string }>;
  shared_teams?: Array<{ id: string; name: string }>;
}

interface BookmarkModalProps {
  bookmark: Bookmark | null;
  folders: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  isOpen: boolean;
  onClose: () => void;
  onTagCreated?: (tag: { id: string; name: string }) => void;
}

export default function BookmarkModal({
  bookmark,
  folders,
  tags,
  teams,
  isOpen,
  onClose,
  onTagCreated,
}: BookmarkModalProps) {
  const { t } = useTranslation();
  useAuth();
  const { plan } = useOrgPlan();
  const { showToast } = useToast();
  const [formData, setFormData] = useState({
    title: '',
    url: '',
    slug: '',
    forwarding_enabled: false,
    folder_ids: [] as string[],
    tag_ids: [] as string[],
    team_ids: [] as string[],
    user_ids: [] as string[],
    share_all_teams: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (bookmark) {
      setFormData({
        title: bookmark.title,
        url: bookmark.url,
        slug: (bookmark.slug && !bookmark.slug.startsWith('_internal_')) ? bookmark.slug : '',
        forwarding_enabled: bookmark.forwarding_enabled,
        folder_ids: (bookmark as any).folders?.map((f: any) => f.id) || [],
        tag_ids: bookmark.tags?.map((t) => t.id) || [],
        team_ids: bookmark.shared_teams?.map((t) => t.id) || [],
        user_ids: (bookmark as any).shared_users?.map((u: any) => u.id) || [],
        share_all_teams: (bookmark as any).share_all_teams || false,
      });
    } else {
      setFormData({
        title: '',
        url: '',
        slug: '',
        forwarding_enabled: false,
        folder_ids: [],
        tag_ids: [],
        team_ids: [],
        user_ids: [],
        share_all_teams: false,
      });
    }
  }, [bookmark, isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const payload: any = {
        title: formData.title,
        url: formData.url,
        forwarding_enabled: formData.forwarding_enabled,
        folder_ids: formData.folder_ids.length > 0 ? formData.folder_ids : undefined,
        tag_ids: formData.tag_ids.length > 0 ? formData.tag_ids : undefined,
        team_ids: formData.team_ids.length > 0 ? formData.team_ids : undefined,
        user_ids: formData.user_ids.length > 0 ? formData.user_ids : undefined,
        share_all_teams: formData.share_all_teams || undefined,
      };

      if (formData.forwarding_enabled) {
        if (!formData.slug || !formData.slug.trim()) {
          setError(t('bookmarks.slugRequired'));
          setLoading(false);
          return;
        }
        payload.slug = formData.slug.trim();
      } else {
        payload.slug = formData.slug && formData.slug.trim() ? formData.slug.trim() : '';
      }

      Object.keys(payload).forEach(key => {
        if (payload[key] === undefined) {
          delete payload[key];
        }
      });
      if (bookmark) {
        await api.put(`/bookmarks/${bookmark.id}`, payload);
      } else {
        await api.post('/bookmarks', payload);
      }
      onClose();
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || t('common.error');
      const code = err.response?.data?.code;
      setError(errorMessage);
      if (code === 'PLAN_LIMIT_BOOKMARKS' || code === 'PLAN_SHARE_TO_TEAM' || code === 'PLAN_FOLDER_SHARING') {
        showToast(errorMessage, 'error');
      }
    } finally {
      setLoading(false);
    }
  }

  const selectedTags = tags.filter((tag) => formData.tag_ids.includes(tag.id));
  const selectedFolders = folders.filter((folder) => formData.folder_ids.includes(folder.id));
  const canShare = canShareToTeams(plan);
  const isValid = formData.title.trim() && formData.url.trim();
  const slugError = formData.forwarding_enabled && !formData.slug?.trim() ? t('bookmarks.slugRequired') : undefined;

  const handleTagChange = (newTags: Array<{ id: string; name: string }>) => {
    setFormData({ ...formData, tag_ids: newTags.map((t) => t.id) });
  };

  const handleFolderChange = (newFolders: Array<{ id: string; name: string }>) => {
    setFormData({ ...formData, folder_ids: newFolders.map((f) => f.id) });
  };

  const handleCreateTag = async (name: string): Promise<{ id: string; name: string } | null> => {
    try {
      const response = await api.post('/tags', { name });
      const newTag = { id: response.data.id, name: response.data.name };
      if (onTagCreated) {
        onTagCreated(newTag);
      }
      return newTag;
    } catch {
      return null;
    }
  };

  const handleSharingChange = (sharing: { user_ids: string[]; team_ids: string[]; share_all_teams: boolean }) => {
    setFormData({
      ...formData,
      user_ids: sharing.user_ids,
      team_ids: sharing.team_ids,
      share_all_teams: sharing.share_all_teams,
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{bookmark ? t('bookmarks.edit') : t('bookmarks.create')}</DialogTitle>
        </DialogHeader>
        <Separator />

        <form id="bookmark-form" onSubmit={handleSubmit} className="space-y-6">
          <ModalSection>
            <FormFieldWrapper
              label={t('bookmarks.name')}
              required
              error={error}
            >
              <Input
                type="text"
                required
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder={t('bookmarks.name')}
              />
            </FormFieldWrapper>
            <FormFieldWrapper label={t('bookmarks.url')} required>
              <Input
                type="url"
                required
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                placeholder={t('bookmarks.url')}
              />
            </FormFieldWrapper>
          </ModalSection>

          <Separator />

          <ModalSection title={t('bookmarks.folders')}>
            {folders.length > 0 ? (
              <Autocomplete
                value={selectedFolders}
                onChange={handleFolderChange}
                options={folders}
                placeholder={t('bookmarks.foldersDescription')}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('bookmarks.noFoldersAvailable')}
              </p>
            )}
            <div>
              <Label className="text-sm font-medium mb-2 block">{t('bookmarks.tags')}</Label>
              <Autocomplete
                value={selectedTags}
                onChange={handleTagChange}
                options={tags}
                placeholder={t('bookmarks.tags')}
                onCreateNew={handleCreateTag}
              />
            </div>
          </ModalSection>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <Label htmlFor="forwarding" className="text-sm font-medium cursor-pointer">
              {t('bookmarks.forwardingEnabled')}
            </Label>
            <Switch
              id="forwarding"
              checked={formData.forwarding_enabled}
              onCheckedChange={(checked) =>
                setFormData({ ...formData, forwarding_enabled: checked })
              }
            />
          </div>

          {(formData.forwarding_enabled || canShare) && <Separator />}

          {formData.forwarding_enabled && (
            <ModalSection>
              <FormFieldWrapper
                label={t('bookmarks.slug')}
                required
                error={slugError}
              >
                <Input
                  type="text"
                  value={formData.slug || ''}
                  onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                  placeholder={t('bookmarks.slug')}
                />
              </FormFieldWrapper>
              {formData.slug && (
                <div className="rounded-lg border bg-muted/50 p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('bookmarks.forwardingPreview')}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono truncate">
                      {window.location.origin}/go/{formData.slug}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        const url = `${window.location.origin}/go/${formData.slug}`;
                        navigator.clipboard.writeText(url);
                        setCopied(true);
                        showToast(t('common.copied'), 'success');
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="p-1.5 rounded-md hover:bg-muted transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                      title={t('bookmarks.copyUrl')}
                      aria-label={t('bookmarks.copyUrl')}
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('bookmarks.forwardingPreviewDescription')}
                  </p>
                </div>
              )}
            </ModalSection>
          )}

          {canShare && (
            <ModalSection title={t('bookmarks.shareWithTeams')}>
              <SharingField
                value={{
                  user_ids: formData.user_ids,
                  team_ids: formData.team_ids,
                  share_all_teams: formData.share_all_teams,
                }}
                onChange={handleSharingChange}
                teams={teams}
                allowTeamSharing={canShareToTeams(plan)}
              />
            </ModalSection>
          )}
        </form>

        <Separator />
        <DialogFooter className="flex-row justify-between sm:justify-end gap-2">
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            loading={loading}
            submitDisabled={!isValid || !!slugError}
            formId="bookmark-form"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

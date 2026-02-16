import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
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
import Autocomplete from '../ui/Autocomplete';
import { Copy, Check, Loader2 } from 'lucide-react';
import { useToast } from '../ui/Toast';

const AI_DEBOUNCE_MS = 500;
const isValidUrl = (url: string): boolean => {
  const t = url.trim();
  return t.length > 0 && /^https?:\/\/.+/.test(t);
};

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
  isOpen: boolean;
  onClose: () => void;
  onTagCreated?: (tag: { id: string; name: string }) => void;
}

export default function BookmarkModal({
  bookmark,
  folders,
  tags,
  isOpen,
  onClose,
  onTagCreated,
}: BookmarkModalProps) {
  const { t } = useTranslation();
  useAuth();
  const { showToast } = useToast();
  const [formData, setFormData] = useState({
    title: '',
    url: '',
    slug: '',
    forwarding_enabled: false,
    folder_ids: [] as string[],
    tag_ids: [] as string[],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCreateTag = useCallback(async (name: string): Promise<{ id: string; name: string } | null> => {
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
  }, [onTagCreated]);

  useEffect(() => {
    if (!isOpen) return;
    api.get('/config/ai-suggestions')
      .then((res) => setAiEnabled(res.data?.enabled === true))
      .catch(() => setAiEnabled(false));
  }, [isOpen]);

  const fetchAISuggestions = useCallback(async (url: string) => {
    if (!aiEnabled || bookmark) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setAiLoading(true);
    try {
      const res = await api.post(
        '/bookmarks/ai-suggest',
        { url },
        { signal: abortRef.current.signal }
      );
      const { title, slug, tags: tagNames } = res.data;
      setFormData((prev) => {
        const next = { ...prev };
        if (title) next.title = title;
        if (slug) next.slug = slug;
        return next;
      });
      if (Array.isArray(tagNames) && tagNames.length > 0) {
        const idsToAdd: string[] = [];
        const existingByName = new Map(tags.map((t) => [t.name.toLowerCase(), t]));
        for (const name of tagNames) {
          const existing = existingByName.get(name.toLowerCase());
          if (existing) {
            idsToAdd.push(existing.id);
          } else {
            const created = await handleCreateTag(name);
            if (created) idsToAdd.push(created.id);
          }
        }
        if (idsToAdd.length > 0) {
          setFormData((prev) => ({
            ...prev,
            tag_ids: [...new Set([...prev.tag_ids, ...idsToAdd])],
          }));
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError' && err?.code !== 'ERR_CANCELED') {
        // Silently ignore - bookmark creation never depends on AI
      }
    } finally {
      setAiLoading(false);
      abortRef.current = null;
    }
  }, [aiEnabled, bookmark, tags]);

  useEffect(() => {
    if (bookmark || !aiEnabled || !isOpen) return;
    const url = formData.url.trim();
    if (!isValidUrl(url)) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      fetchAISuggestions(url);
    }, AI_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [formData.url, aiEnabled, bookmark, isOpen, fetchAISuggestions]);

  useEffect(() => {
    if (bookmark) {
      setFormData({
        title: bookmark.title,
        url: bookmark.url,
        slug: (bookmark.slug && !bookmark.slug.startsWith('_internal_')) ? bookmark.slug : '',
        forwarding_enabled: bookmark.forwarding_enabled,
        folder_ids: (bookmark as any).folders?.map((f: any) => f.id) || [],
        tag_ids: bookmark.tags?.map((t) => t.id) || [],
      });
    } else {
      setFormData({
        title: '',
        url: '',
        slug: '',
        forwarding_enabled: false,
        folder_ids: [],
        tag_ids: [],
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
  const isValid = formData.title.trim() && formData.url.trim();
  const slugError = formData.forwarding_enabled && !formData.slug?.trim() ? t('bookmarks.slugRequired') : undefined;

  const handleTagChange = (newTags: Array<{ id: string; name: string }>) => {
    setFormData({ ...formData, tag_ids: newTags.map((t) => t.id) });
  };

  const handleFolderChange = (newFolders: Array<{ id: string; name: string }>) => {
    setFormData({ ...formData, folder_ids: newFolders.map((f) => f.id) });
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
              {aiLoading && (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('bookmarks.aiSuggesting')}
                </p>
              )}
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
              {aiLoading && (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('bookmarks.aiSuggesting')}
                </p>
              )}
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

          {formData.forwarding_enabled && (
            <>
              <Separator />
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
                {aiLoading && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('bookmarks.aiSuggesting')}
                  </p>
                )}
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
            </>
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

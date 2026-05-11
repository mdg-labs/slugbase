import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { usePlan, isCloudMode } from '../../contexts/PlanContext';
import api from '../../api/client';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
import { FormFieldWrapper } from '../ui/FormFieldWrapper';
import { ModalFooterActions } from '../ui/ModalFooterActions';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import Autocomplete from '../ui/Autocomplete';
import { Bookmark, Check, Copy, Link2, Loader2, Plus, Sparkles } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { cn } from '@/lib/utils';

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
  pinned?: boolean;
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
  const planInfo = usePlan();
  const { showToast } = useToast();
  const [formData, setFormData] = useState({
    title: '',
    url: '',
    slug: '',
    forwarding_enabled: false,
    pinned: false,
    folder_ids: [] as string[],
    tag_ids: [] as string[],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<{
    title?: string;
    slug?: string;
    tags?: string[];
  } | null>(null);
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
    if (isCloudMode && planInfo != null && !planInfo.aiAvailable) {
      setAiEnabled(false);
      return;
    }
    api
      .get('/config/ai-suggestions')
      .then((res) => {
        let enabled = res.data?.enabled === true;
        if (isCloudMode && planInfo != null && !planInfo.aiAvailable) enabled = false;
        setAiEnabled(enabled);
      })
      .catch(() => setAiEnabled(false));
  }, [isOpen, planInfo]);

  const fetchAISuggestions = useCallback(async (url: string) => {
    if (!aiEnabled || bookmark) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setAiLoading(true);
    setAiSuggestions(null);
    try {
      const res = await api.post(
        '/bookmarks/ai-suggest',
        { url },
        { signal: abortRef.current.signal }
      );
      const { title, slug, tags: tagNames } = res.data;
      setAiSuggestions({
        title: title || undefined,
        slug: slug || undefined,
        tags: Array.isArray(tagNames) && tagNames.length > 0 ? tagNames : undefined,
      });
    } catch (err: any) {
      if (err?.name !== 'AbortError' && err?.code !== 'ERR_CANCELED') {
        // Silently ignore - bookmark creation never depends on AI
      }
    } finally {
      setAiLoading(false);
      abortRef.current = null;
    }
  }, [aiEnabled, bookmark]);

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
        pinned: bookmark.pinned ?? false,
        folder_ids: (bookmark as any).folders?.map((f: any) => f.id) || [],
        tag_ids: bookmark.tags?.map((tg) => tg.id) || [],
      });
      setAiSuggestions(null);
    } else {
      setFormData({
        title: '',
        url: '',
        slug: '',
        forwarding_enabled: false,
        pinned: false,
        folder_ids: [],
        tag_ids: [],
      });
      if (!isOpen) setAiSuggestions(null);
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
        pinned: formData.pinned,
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

      if (aiSuggestions != null) {
        const titleUsed = Boolean(aiSuggestions.title && formData.title.trim() === aiSuggestions.title);
        const slugUsed = Boolean(aiSuggestions.slug && formData.slug?.trim() === aiSuggestions.slug);
        const selectedTagsForSubmit = tags.filter((tg) => formData.tag_ids.includes(tg.id));
        const selectedTagNamesLower = new Set(selectedTagsForSubmit.map((tg) => tg.name.toLowerCase()));
        const tagsUsed =
          Boolean(aiSuggestions.tags?.length) &&
          aiSuggestions.tags!.every((name: string) => selectedTagNamesLower.has(name.toLowerCase()));
        payload.ai_suggestion_used = { title: titleUsed, slug: slugUsed, tags: tagsUsed };
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
    setFormData({ ...formData, tag_ids: newTags.map((tg) => tg.id) });
  };

  const handleFolderChange = (newFolders: Array<{ id: string; name: string }>) => {
    setFormData({ ...formData, folder_ids: newFolders.map((f) => f.id) });
  };

  const handleAddTitleSuggestion = () => {
    if (aiSuggestions?.title) {
      setFormData((prev) => ({ ...prev, title: aiSuggestions.title! }));
    }
  };

  const handleAddSlugSuggestion = () => {
    if (aiSuggestions?.slug) {
      setFormData((prev) => ({ ...prev, slug: aiSuggestions.slug! }));
    }
  };

  const handleAddTagSuggestion = async (tagName: string) => {
    const existingByName = new Map(tags.map((tg) => [tg.name.toLowerCase(), tg]));
    const existing = existingByName.get(tagName.toLowerCase());
    if (existing) {
      setFormData((prev) => ({
        ...prev,
        tag_ids: [...new Set([...prev.tag_ids, existing.id])],
      }));
    } else {
      const created = await handleCreateTag(tagName);
      if (created) {
        setFormData((prev) => ({
          ...prev,
          tag_ids: [...new Set([...prev.tag_ids, created.id])],
        }));
      }
    }
  };

  const selectedTagNames = new Set(selectedTags.map((tg) => tg.name.toLowerCase()));

  const showAiBand =
    !bookmark &&
    aiEnabled &&
    (aiLoading ||
      (aiSuggestions != null &&
        Boolean(aiSuggestions.title || aiSuggestions.slug || (aiSuggestions.tags && aiSuggestions.tags.length > 0))));

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent wide className="flex max-h-[90vh] flex-col p-0">
        <ModalHead
          icon={Bookmark}
          title={bookmark ? t('bookmarks.edit') : t('bookmarks.create')}
        />

        <ModalBody>
          <p className="-mt-1 mb-4 text-[12.5px] text-[var(--fg-2)]">{t('bookmarks.modalSubtitle')}</p>

          <form id="bookmark-form" onSubmit={handleSubmit} className="space-y-0">
            <div
              className={cn(
                'gap-4',
                showAiBand ? 'grid lg:grid-cols-[minmax(0,1fr)_200px] lg:items-start' : 'flex flex-col'
              )}
            >
              <div className="min-w-0 space-y-4">
                <FormFieldWrapper label={t('bookmarks.url')} required>
                  <Input
                    type="url"
                    required
                    value={formData.url}
                    onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                    placeholder="https://"
                    leftSlot={<Link2 strokeWidth={1.75} aria-hidden />}
                  />
                </FormFieldWrapper>

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

                <div>
                  <Label className="mb-2 block text-[12.5px] font-medium text-[var(--fg-0)]">{t('bookmarks.folders')}</Label>
                  {folders.length > 0 ? (
                    <Autocomplete
                      value={selectedFolders}
                      onChange={handleFolderChange}
                      options={folders}
                      placeholder={t('bookmarks.foldersDescription')}
                    />
                  ) : (
                    <p className="text-[12.5px] text-[var(--fg-2)]">{t('bookmarks.noFoldersAvailable')}</p>
                  )}
                </div>

                <div>
                  <Label className="mb-2 block text-[12.5px] font-medium text-[var(--fg-0)]">{t('bookmarks.tags')}</Label>
                  <Autocomplete
                    value={selectedTags}
                    onChange={handleTagChange}
                    options={tags}
                    placeholder={t('bookmarks.tagsAddPlaceholder')}
                    onCreateNew={handleCreateTag}
                    pillChips
                  />
                </div>

                <div className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2.5">
                  <Label htmlFor="pinned" className="cursor-pointer text-[12.5px] font-medium text-[var(--fg-0)]">
                    {t('bookmarks.pinned')}
                  </Label>
                  <Switch
                    id="pinned"
                    checked={formData.pinned}
                    onCheckedChange={(checked) => setFormData({ ...formData, pinned: !!checked })}
                  />
                </div>
                <div className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2.5">
                  <Label htmlFor="forwarding" className="cursor-pointer text-[12.5px] font-medium text-[var(--fg-0)]">
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

                {formData.forwarding_enabled ? (
                  <div className="space-y-4 border-t border-[var(--border)] pt-4">
                    <FormFieldWrapper
                      label={t('bookmarks.slug')}
                      required
                      error={slugError}
                      htmlFor="bookmark-slug"
                    >
                      <Input
                        id="bookmark-slug"
                        type="text"
                        value={formData.slug || ''}
                        onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                        placeholder={t('bookmarks.slug')}
                        leftSlot={
                          <span className="select-none font-mono text-[11px] text-[var(--fg-3)]" aria-hidden>
                            /go/
                          </span>
                        }
                      />
                    </FormFieldWrapper>
                    {formData.slug ? (
                      <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2.5">
                        <p className="text-[11px] font-medium text-[var(--fg-2)]">{t('bookmarks.forwardingPreview')}</p>
                        <div className="mt-1 flex items-center gap-2">
                          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--fg-0)]">
                            {window.location.origin}/go/{formData.slug}
                          </code>
                          <button
                            type="button"
                            onClick={() => {
                              const u = `${window.location.origin}/go/${formData.slug}`;
                              navigator.clipboard.writeText(u);
                              setCopied(true);
                              showToast(t('common.copied'), 'success');
                              setTimeout(() => setCopied(false), 2000);
                            }}
                            className="rounded-md p-1.5 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                            title={t('bookmarks.copyUrl')}
                            aria-label={t('bookmarks.copyUrl')}
                          >
                            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </button>
                        </div>
                        <p className="mt-1 text-[11px] text-[var(--fg-2)]">{t('bookmarks.forwardingPreviewDescription')}</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {showAiBand ? (
                <aside className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] p-3 lg:sticky lg:top-0">
                  <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--fg-3)]">
                    <Sparkles className="size-3.5 text-[var(--accent-hi)]" aria-hidden />
                    {t('bookmarks.aiSuggestionsLabel')}
                  </div>
                  {aiLoading ? (
                    <p className="flex items-center gap-1.5 text-[12px] text-[var(--fg-2)]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('bookmarks.aiSuggesting')}
                    </p>
                  ) : (
                    <div className="space-y-2 text-[12px]">
                      {aiSuggestions?.title ? (
                        <button
                          type="button"
                          onClick={handleAddTitleSuggestion}
                          className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-soft)] bg-[var(--bg-1)] px-2 py-1.5 text-left text-[var(--fg-0)] transition-colors hover:bg-[var(--bg-3)]"
                        >
                          <span className="min-w-0 truncate">{aiSuggestions.title}</span>
                          <Plus className="h-3.5 w-3.5 shrink-0" />
                        </button>
                      ) : null}
                      {aiSuggestions?.slug ? (
                        <button
                          type="button"
                          onClick={handleAddSlugSuggestion}
                          className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-soft)] bg-[var(--bg-1)] px-2 py-1.5 font-mono text-[11px] text-[var(--fg-0)]"
                        >
                          <span className="min-w-0 truncate">{aiSuggestions.slug}</span>
                          <Plus className="h-3.5 w-3.5 shrink-0" />
                        </button>
                      ) : null}
                      {aiSuggestions?.tags?.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {aiSuggestions.tags
                            .filter((name) => !selectedTagNames.has(name.toLowerCase()))
                            .map((tagName) => (
                              <button
                                key={tagName}
                                type="button"
                                onClick={() => handleAddTagSuggestion(tagName)}
                                className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-bg)] px-2 py-0.5 text-[11px] text-[var(--fg-0)] ring-1 ring-inset ring-[var(--accent-ring)]"
                              >
                                {tagName}
                                <Plus className="h-3 w-3" />
                              </button>
                            ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                </aside>
              ) : null}
            </div>
          </form>
        </ModalBody>

        <ModalFoot>
          <ModalFooterActions
            onCancel={onClose}
            cancelVariant="ghost"
            submitLabel={t('common.save')}
            loading={loading}
            submitDisabled={!isValid || !!slugError}
            formId="bookmark-form"
          />
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

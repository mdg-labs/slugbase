import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../api/client';
import Modal from '../ui/Modal';
import Autocomplete from '../ui/Autocomplete';
import Button from '../ui/Button';
import SharingModal from './SharingModal';
import { Share2, Copy, Check } from 'lucide-react';
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
  const { user } = useAuth();
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
  const [sharingModalOpen, setSharingModalOpen] = useState(false);
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
      
      // Only include slug if forwarding is enabled (required) or if user provided one (optional when forwarding disabled)
      if (formData.forwarding_enabled) {
        if (!formData.slug || !formData.slug.trim()) {
          setError(t('bookmarks.slugRequired'));
          setLoading(false);
          return;
        }
        payload.slug = formData.slug.trim();
      } else {
        // When forwarding is disabled, always send slug (empty string will be converted to NULL on backend)
        // This ensures we clear any existing slug when forwarding is disabled
        payload.slug = formData.slug && formData.slug.trim() ? formData.slug.trim() : '';
      }
      
      // Remove undefined values
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
      setError(errorMessage);
      // If it's a slug uniqueness error, highlight the slug field
      if (errorMessage.includes(t('bookmarks.slugAlreadyExists')) || errorMessage.toLowerCase().includes('slug') && errorMessage.toLowerCase().includes('exists')) {
        // Error is already set, user will see it
      }
    } finally {
      setLoading(false);
    }
  }

  const selectedTags = tags.filter((tag) => formData.tag_ids.includes(tag.id));
  const selectedFolders = folders.filter((folder) => formData.folder_ids.includes(folder.id));

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
      // Notify parent to refresh tags list
      if (onTagCreated) {
        onTagCreated(newTag);
      }
      return newTag;
    } catch {
      return null;
    }
  };


  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={bookmark ? t('bookmarks.edit') : t('bookmarks.create')}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              {t('bookmarks.name')}
            </label>
            <input
              type="text"
              required
              className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              {t('bookmarks.url')}
            </label>
            <input
              type="url"
              required
              className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
              value={formData.url}
              onChange={(e) => setFormData({ ...formData, url: e.target.value })}
            />
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="forwarding"
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
              checked={formData.forwarding_enabled}
              onChange={(e) => setFormData({ ...formData, forwarding_enabled: e.target.checked })}
            />
            <label htmlFor="forwarding" className="text-sm font-medium text-gray-900 dark:text-white">
              {t('bookmarks.forwardingEnabled')}
            </label>
          </div>

          {formData.forwarding_enabled && (
            <div className="animate-in slide-in-from-top-2 duration-200">
              <div>
                <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                  {t('bookmarks.slug')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                  value={formData.slug || ''}
                  onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                />
              </div>
              {formData.slug && (
                <div className="mt-3 animate-in slide-in-from-top-2 duration-200">
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('bookmarks.forwardingPreview')}
                  </label>
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                    <code className="flex-1 text-xs font-mono text-blue-800 dark:text-blue-200 truncate">
                      {window.location.origin}/{bookmark?.owner_user_key ?? user?.user_key}/{formData.slug}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        const url = `${window.location.origin}/${bookmark?.owner_user_key ?? user?.user_key}/${formData.slug}`;
                        navigator.clipboard.writeText(url);
                        setCopied(true);
                        showToast(t('common.copied'), 'success');
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="flex-shrink-0 p-1.5 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded-md transition-colors"
                      title={t('bookmarks.copyUrl')}
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                    {t('bookmarks.forwardingPreviewDescription')}
                  </p>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              {t('bookmarks.folders')}
            </label>
            {folders.length > 0 ? (
              <Autocomplete
                value={selectedFolders}
                onChange={handleFolderChange}
                options={folders}
                placeholder={t('bookmarks.foldersDescription')}
              />
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('bookmarks.noFoldersAvailable')}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              {t('bookmarks.tags')}
            </label>
            <Autocomplete
              value={selectedTags}
              onChange={handleTagChange}
              options={tags}
              placeholder={t('bookmarks.tags')}
              onCreateNew={handleCreateTag}
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              <Share2 className="inline h-4 w-4 mr-1.5" />
              {t('bookmarks.shareWithTeams')}
            </label>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setSharingModalOpen(true)}
              className="w-full"
            >
              {formData.share_all_teams
                ? t('bookmarks.shareAllTeams')
                : formData.team_ids.length > 0 || formData.user_ids.length > 0
                ? t('bookmarks.sharingSummary', { 
                    teamCount: formData.team_ids.length, 
                    teams: formData.team_ids.length === 1 ? t('common.team') : t('common.teams'),
                    userCount: formData.user_ids.length,
                    users: formData.user_ids.length === 1 ? t('common.user') : t('common.users')
                  })
                : t('bookmarks.shareWithTeams')}
            </Button>
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={loading} className="flex-1">
              {loading ? t('common.loading') : t('common.save')}
            </Button>
          </div>
        </form>
      </Modal>

      {sharingModalOpen && (
        <SharingModal
          isOpen={sharingModalOpen}
          onClose={() => setSharingModalOpen(false)}
          onSave={(sharing) => {
            setFormData({
              ...formData,
              user_ids: sharing.user_ids,
              team_ids: sharing.team_ids,
              share_all_teams: sharing.share_all_teams,
            });
            setSharingModalOpen(false);
          }}
          currentShares={{
            user_ids: formData.user_ids,
            team_ids: formData.team_ids,
            share_all_teams: formData.share_all_teams,
          }}
          teams={teams}
          type="bookmark"
        />
      )}
    </>
  );
}

import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
import { useOrgPlan } from '../../contexts/OrgPlanContext';
import { canShareFolders } from '../../utils/plan';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import SharingModal from './SharingModal';
import FolderIcon, { popularIcons, getAllIcons } from '../FolderIcon';
import { Share2, Search, X } from 'lucide-react';
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
  teams: Array<{ id: string; name: string }>;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function FolderModal({
  folder,
  teams,
  isOpen,
  onClose,
  onSuccess,
}: FolderModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { plan } = useOrgPlan();
  const showShareSection = canShareFolders(plan);
  const [formData, setFormData] = useState({
    name: '',
    icon: '',
    team_ids: [] as string[],
    user_ids: [] as string[],
    share_all_teams: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sharingModalOpen, setSharingModalOpen] = useState(false);
  const [iconSearchQuery, setIconSearchQuery] = useState('');
  const [showAllIcons, setShowAllIcons] = useState(false);
  
  // Get all available icons
  const allIcons = useMemo(() => getAllIcons(), []);
  
  // Filter icons based on search
  const filteredIcons = useMemo(() => {
    const iconsToSearch = showAllIcons ? allIcons : popularIcons;
    if (!iconSearchQuery.trim()) {
      return iconsToSearch;
    }
    const query = iconSearchQuery.toLowerCase();
    const filtered = iconsToSearch.filter((iconName) => 
      iconName.toLowerCase().includes(query)
    );
    
    // If search query matches an icon name exactly (case-insensitive) and it's not in the filtered list,
    // add it so users can select any icon by typing its name
    const exactMatch = allIcons.find(icon => icon.toLowerCase() === query);
    if (exactMatch && !filtered.includes(exactMatch)) {
      return [exactMatch, ...filtered];
    }
    
    return filtered;
  }, [iconSearchQuery, showAllIcons, allIcons]);
  
  // Check if the current search query is a valid icon name
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
        team_ids: folder.shared_teams?.map((t) => t.id) || [],
        user_ids: (folder as any).shared_users?.map((u: any) => u.id) || [],
        share_all_teams: (folder as any).share_all_teams || false,
      });
    } else {
      setFormData({ name: '', icon: '', team_ids: [], user_ids: [], share_all_teams: false });
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
        team_ids: formData.team_ids.length > 0 ? formData.team_ids : undefined,
        user_ids: formData.user_ids.length > 0 ? formData.user_ids : undefined,
        share_all_teams: formData.share_all_teams || undefined,
      };
      
      // Remove undefined values
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

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={folder ? t('folders.edit') : t('folders.create')}
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
            {t('folders.name')}
          </label>
          <input
            type="text"
            required
            className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
            {t('folders.icon')}
          </label>
          
          {/* Search and toggle */}
          <div className="mb-3 space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder={t('folders.searchIcons')}
                value={iconSearchQuery}
                onChange={(e) => setIconSearchQuery(e.target.value)}
                className="w-full pl-10 pr-10 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {iconSearchQuery && (
                <button
                  type="button"
                  onClick={() => setIconSearchQuery('')}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500 dark:text-gray-400">
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
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {showAllIcons ? t('folders.showPopularOnly') : t('folders.showAllIcons')}
              </button>
            </div>
          </div>

          {/* Quick apply button for typed icon name */}
          {isValidIconName && iconSearchQuery.trim() && !filteredIcons.some(icon => icon.toLowerCase() === iconSearchQuery.trim().toLowerCase()) && (
            <div className="mb-2">
              <button
                type="button"
                onClick={() => {
                  const query = iconSearchQuery.trim();
                  // Find the exact icon name (case-sensitive match from allIcons)
                  const matchedIcon = allIcons.find(icon => icon.toLowerCase() === query.toLowerCase());
                  if (matchedIcon) {
                    setFormData({ ...formData, icon: matchedIcon });
                    setIconSearchQuery('');
                  }
                }}
                className="w-full px-3 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors flex items-center justify-center gap-2"
              >
                <span>
                  {t('folders.useIcon')}: <code className="px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 rounded">{allIcons.find(icon => icon.toLowerCase() === iconSearchQuery.trim().toLowerCase())}</code>
                </span>
              </button>
            </div>
          )}

          {/* Icon grid */}
          <div className="grid grid-cols-8 gap-2 max-h-64 overflow-y-auto p-2 border border-gray-200 dark:border-gray-700 rounded-lg">
            {/* No icon option */}
            <button
              type="button"
              onClick={() => setFormData({ ...formData, icon: '' })}
              className={`p-2 rounded-lg border-2 transition-colors ${
                formData.icon === ''
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
              title={t('folders.noIcon')}
            >
              <FolderIcon iconName={null} size={20} className="mx-auto text-gray-400" />
            </button>
            
            {/* Filtered icons */}
            {filteredIcons.length === 0 ? (
              <div className="col-span-8 text-center py-8 text-sm text-gray-500 dark:text-gray-400">
                {t('folders.noIconsFound')}
                {!isValidIconName && iconSearchQuery.trim() && (
                  <p className="mt-2 text-xs">
                    {t('folders.typeIconName')}
                  </p>
                )}
              </div>
            ) : (
              filteredIcons.map((iconName) => {
                // Try exact match first
                let IconComponent = (LucideIcons as any)[iconName];
                
                // If not found, try case-insensitive lookup
                if (!IconComponent) {
                  const iconNameLower = iconName.toLowerCase();
                  for (const key in LucideIcons) {
                    if (key.toLowerCase() === iconNameLower) {
                      const candidate = (LucideIcons as any)[key];
                      // Check if it's a valid component (function or forward ref object)
                      const isValid = typeof candidate === 'function' || 
                        (candidate && typeof candidate === 'object' && (candidate.$$typeof || candidate.render));
                      if (isValid) {
                        IconComponent = candidate;
                        break;
                      }
                    }
                  }
                }
                
                // Verify IconComponent is valid (function component or forward ref)
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
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                    title={iconName}
                  >
                    <IconComponent className="h-5 w-5 mx-auto text-gray-600 dark:text-gray-400" />
                  </button>
                );
              })
            )}
          </div>
          
          {/* Selected icon info */}
          {formData.icon && (
            <div className="mt-2 flex items-center gap-2 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
              <FolderIcon iconName={formData.icon} size={20} className="text-blue-600 dark:text-blue-400" />
              <div className="flex-1">
                <p className="text-xs font-medium text-blue-900 dark:text-blue-200">
                  {t('folders.selectedIcon')}
                </p>
                <p className="text-xs text-blue-700 dark:text-blue-300 font-mono">
                  {formData.icon}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFormData({ ...formData, icon: '' })}
                className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200"
                title={t('folders.clearIcon')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {showShareSection && (
        <div>
          <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
            <Share2 className="inline h-4 w-4 mr-1.5" />
            {t('folders.shareWithTeams')}
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
              : t('folders.shareWithTeams')}
          </Button>
        </div>
        )}

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

      {showShareSection && sharingModalOpen && (
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
          type="folder"
          allowTeamSharing={canShareFolders(plan)}
        />
      )}
    </>
  );
}

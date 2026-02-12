import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Share2, LayoutGrid, List } from 'lucide-react';
import FolderModal from '../components/modals/FolderModal';
import Button from '../components/ui/Button';
import Select from '../components/ui/Select';
import Tooltip from '../components/ui/Tooltip';
import FolderIcon from '../components/FolderIcon';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';

interface Folder {
  id: string;
  name: string;
  icon?: string | null;
  shared_teams?: Array<{ id: string; name: string }>;
  shared_users?: Array<{ id: string; name: string; email: string }>;
  folder_type?: 'own' | 'shared';
  created_at?: string;
}

type ViewMode = 'card' | 'list';
type SortOption = 'alphabetical' | 'recently_added';

export default function Folders() {
  const { t } = useTranslation();
  const { showConfirm, dialogState } = useConfirmDialog();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('folders-view-mode');
    return (saved === 'list' || saved === 'card') ? saved : 'card';
  });
  const [compactMode, setCompactMode] = useState(() => {
    return localStorage.getItem('folders-compact-mode') === 'true';
  });
  const [sortBy, setSortBy] = useState<SortOption>('alphabetical');

  useEffect(() => {
    localStorage.setItem('folders-view-mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('folders-compact-mode', compactMode.toString());
  }, [compactMode]);

  useEffect(() => {
    loadData();
  }, [sortBy]);

  async function loadData() {
    try {
      const [foldersRes, teamsRes] = await Promise.all([
        api.get('/folders', { params: { sort_by: sortBy } }),
        api.get('/teams'),
      ]);
      // Filter to only show own folders (not shared)
      const ownFolders = foldersRes.data.filter((f: Folder) => f.folder_type === 'own');
      setFolders(ownFolders);
      setTeams(teamsRes.data);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }

  const sortedFolders = useMemo(() => {
    // Backend already sorts, but we can do client-side sorting if needed
    return [...folders];
  }, [folders]);

  function handleCreate() {
    setEditingFolder(null);
    setModalOpen(true);
  }

  function handleEdit(folder: Folder) {
    setEditingFolder(folder);
    setModalOpen(true);
  }

  function handleDelete(id: string) {
    const folder = folders.find(f => f.id === id);
    const folderName = folder?.name || 'this folder';
    showConfirm(
      t('folders.deleteFolder'),
      t('folders.deleteConfirmWithName', { name: folderName }),
      async () => {
        try {
          await api.delete(`/folders/${id}`);
          loadData();
        } catch (error) {
          console.error('Failed to delete folder:', error);
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  }

  function handleModalClose() {
    setModalOpen(false);
    setEditingFolder(null);
  }

  const sortOptions = [
    { value: 'alphabetical', label: t('folders.sortAlphabetical') },
    { value: 'recently_added', label: t('folders.sortRecentlyAdded') },
  ];

  if (loading) {
    return <PageLoadingSkeleton lines={6} />;
  }

  return (
    <div className="space-y-6 pb-24">
      {/* Sticky controls bar: header + toolbar - stays visible when scrolling */}
      <div className="sticky top-0 z-40 space-y-4 pb-4 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-0 -mt-8 bg-background border-b shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
              {t('folders.title')}
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              {folders.length} {folders.length === 1 ? t('common.folder') : t('common.folders')}
            </p>
          </div>
          <Button onClick={handleCreate} icon={Plus}>
            {t('folders.create')}
          </Button>
        </div>

        {/* Toolbar: Sort, View Modes */}
        {sortedFolders.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 bg-card rounded-lg border p-4 shadow-sm">
          {/* Sort */}
          <div className="flex items-center gap-2">
            <Select
              value={sortBy}
              onChange={(value) => setSortBy(value as SortOption)}
              options={sortOptions}
              className="min-w-[160px]"
            />
          </div>

          {/* View Mode Toggle */}
          <div className="flex items-center gap-2 border-l border-gray-200 dark:border-gray-700 pl-3 ml-auto">
            <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
              <button
                onClick={() => setViewMode('card')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'card'
                    ? 'bg-white dark:bg-gray-600 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
                title={t('folders.viewCard')}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'list'
                    ? 'bg-white dark:bg-gray-600 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
                title={t('folders.viewList')}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            <button
              onClick={() => setCompactMode(!compactMode)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                compactMode
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
              title={t('folders.compactMode')}
            >
              {t('folders.compactMode')}
            </button>
          </div>
        </div>
        )}
      </div>

      {/* Folders Display */}
      {sortedFolders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 px-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-4">
            <FolderIcon iconName={null} className="h-8 w-8 text-green-600 dark:text-green-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            {t('folders.empty')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 text-center max-w-md">
            {t('folders.emptyDescription')}
          </p>
          <Button onClick={handleCreate} variant="primary" icon={Plus}>
            {t('folders.create')}
          </Button>
        </div>
      ) : viewMode === 'card' ? (
        <div className={`grid grid-cols-1 gap-4 ${
          compactMode 
            ? 'sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6' 
            : 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
        }`}>
          {sortedFolders.map((folder) => (
            <div
              key={folder.id}
              className={`group bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-lg transition-all duration-200 flex flex-col ${compactMode ? 'p-2.5' : 'p-4'}`}
            >
              <div className="space-y-3 flex-1 flex flex-col">
                {/* Header with icon */}
                <div className="flex items-start gap-3">
                  <div className={`flex-shrink-0 ${compactMode ? 'w-10 h-10' : 'w-12 h-12'} rounded-xl bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 flex items-center justify-center border border-blue-100 dark:border-blue-800/50`}>
                    <FolderIcon iconName={folder.icon} size={compactMode ? 20 : 24} className="text-blue-600 dark:text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <h3 className={`${compactMode ? 'text-xs' : 'text-[15px]'} font-medium text-gray-900 dark:text-white truncate mb-1.5`}>
                      {folder.name}
                    </h3>
                    {folder.shared_teams && folder.shared_teams.length > 0 && (
                      <Tooltip
                        content={
                          <div className="space-y-1">
                            <div className="font-semibold mb-1">{t('folders.sharedWith')}</div>
                            {folder.shared_teams.map((team) => (
                              <div key={team.id} className="text-xs">
                                • {team.name}
                              </div>
                            ))}
                            {folder.shared_users && folder.shared_users.length > 0 && (
                              <>
                                {folder.shared_users.map((user) => (
                                  <div key={user.id} className="text-xs">
                                    • {user.name || user.email}
                                  </div>
                                ))}
                              </>
                            )}
                          </div>
                        }
                      >
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md border border-green-200 dark:border-green-800/50 cursor-help">
                          <Share2 className="h-3 w-3" />
                          {t('folders.shared')}
                        </span>
                      </Tooltip>
                    )}
                  </div>
                </div>

                {/* Actions */}
                {folder.folder_type === 'own' && (
                  <div className={`flex gap-2 pt-3 mt-auto border-t border-gray-100 dark:border-gray-700/50 ${compactMode ? 'pt-2' : ''}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Edit}
                      onClick={() => handleEdit(folder)}
                      className={`flex-1 ${compactMode ? 'text-xs px-2 py-1' : 'text-xs'}`}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Trash2}
                      onClick={() => handleDelete(folder.id)}
                      title={t('common.delete')}
                      className={`text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 ${compactMode ? 'px-1.5' : 'px-2'}`}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'} text-left ${compactMode ? 'text-[10px]' : 'text-xs'} font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide`}>
                  {t('folders.name')}
                </th>
                {!compactMode && (
                  <th className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'} text-left ${compactMode ? 'text-[10px]' : 'text-xs'} font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide`}>
                    {t('folders.shared')}
                  </th>
                )}
                <th className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'} text-right ${compactMode ? 'text-[10px]' : 'text-xs'} font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide`}>
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedFolders.map((folder) => (
                <tr
                  key={folder.id}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${compactMode ? 'h-10' : ''}`}
                >
                  <td className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'}`}>
                    <div className={`flex items-center ${compactMode ? 'gap-2' : 'gap-3'}`}>
                      <div className={`flex-shrink-0 ${compactMode ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 flex items-center justify-center border border-blue-100 dark:border-blue-800/50`}>
                        <FolderIcon iconName={folder.icon} size={compactMode ? 12 : 16} className="text-blue-600 dark:text-blue-400" />
                      </div>
                      <div className={`font-medium text-gray-900 dark:text-white ${compactMode ? 'text-xs' : 'text-[15px]'}`}>
                        {folder.name}
                      </div>
                    </div>
                  </td>
                  {!compactMode && (
                    <td className="px-4 py-3">
                      {folder.shared_teams && folder.shared_teams.length > 0 ? (
                        <Tooltip
                          content={
                            <div className="space-y-1">
                              <div className="font-semibold mb-1">{t('folders.sharedWith')}</div>
                              {folder.shared_teams.map((team) => (
                                <div key={team.id} className="text-xs">
                                  • {team.name}
                                </div>
                              ))}
                              {folder.shared_users && folder.shared_users.length > 0 && (
                                <>
                                  {folder.shared_users.map((user) => (
                                    <div key={user.id} className="text-xs">
                                      • {user.name || user.email}
                                    </div>
                                  ))}
                                </>
                              )}
                            </div>
                          }
                        >
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md cursor-help">
                            <Share2 className="h-3 w-3" />
                            {t('folders.shared')}
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-gray-500 dark:text-gray-400">-</span>
                      )}
                    </td>
                  )}
                  <td className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'}`}>
                    {folder.folder_type === 'own' && (
                      <div className={`flex items-center justify-end ${compactMode ? 'gap-1' : 'gap-2'}`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Edit}
                          onClick={() => handleEdit(folder)}
                          className={compactMode ? 'px-1 h-6' : 'px-2'}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Trash2}
                          onClick={() => handleDelete(folder.id)}
                          title={t('common.delete')}
                          className={`text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 ${compactMode ? 'px-1 h-6' : 'px-2'}`}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <FolderModal
        folder={editingFolder}
        teams={teams}
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSuccess={loadData}
      />

      <ConfirmDialog {...dialogState} />
    </div>
  );
}

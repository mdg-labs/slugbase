import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Share2, LayoutGrid, List, Folder } from 'lucide-react';
import FolderModal from '../components/modals/FolderModal';
import ShareResourceDialog from '../components/sharing/ShareResourceDialog';
import Button from '../components/ui/Button';
import Select from '../components/ui/Select';
import Tooltip from '../components/ui/Tooltip';
import FolderIcon from '../components/FolderIcon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { useAppConfig } from '../contexts/AppConfigContext';

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
  const { appBasePath } = useAppConfig();
  const { showConfirm, dialogState } = useConfirmDialog();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null);
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
      const foldersRes = await api.get('/folders', { params: { sort_by: sortBy } });
      // Filter to only show own folders (not shared)
      const ownFolders = foldersRes.data.filter((f: Folder) => f.folder_type === 'own');
      setFolders(ownFolders);
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
        <PageHeader
          className="pt-4"
          title={t('folders.title')}
          subtitle={`${folders.length} ${folders.length === 1 ? t('common.folder') : t('common.folders')}`}
          actions={
            <Button onClick={handleCreate} icon={Plus}>
              {t('folders.create')}
            </Button>
          }
        />

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
                    ? 'bg-card text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={t('folders.viewCard')}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'list'
                    ? 'bg-card text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
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
                  ? 'bg-primary/20 text-primary'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
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
        <EmptyState
          icon={Folder}
          title={t('folders.empty')}
          description={t('folders.emptyDescription')}
          action={
            <Button onClick={handleCreate} variant="primary" icon={Plus}>
              {t('folders.create')}
            </Button>
          }
        />
      ) : viewMode === 'card' ? (
        <div className={`grid grid-cols-1 gap-3 ${
          compactMode 
            ? 'sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8' 
            : 'sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'
        }`}>
          {sortedFolders.map((folder) => (
            <div
              key={folder.id}
              className={`group bg-card rounded-lg border border-border hover:border-primary hover:shadow-lg transition-all duration-200 flex flex-col ${compactMode ? 'p-2.5' : 'p-3'}`}
            >
              <Link
                to={`${appBasePath}/bookmarks?folder_id=${folder.id}`}
                className="flex-1 flex flex-col min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
              >
                <div className="space-y-3 flex-1 flex flex-col">
                  <div className="flex items-start gap-3">
                    <div className={`flex-shrink-0 ${compactMode ? 'w-9 h-9' : 'w-10 h-10'} rounded-xl bg-primary/20 flex items-center justify-center border border-primary/30`}>
                      <FolderIcon iconName={folder.icon} size={compactMode ? 18 : 20} className="text-primary" />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <h3 className={`${compactMode ? 'text-xs' : 'text-sm'} font-medium text-foreground truncate mb-1`}>
                        {folder.name}
                      </h3>
                      {folder.shared_teams && folder.shared_teams.length > 0 && (
                        <Tooltip
                          content={
                            <div className="space-y-1">
                              <div className="font-semibold mb-1">{t('folders.sharedWith')}</div>
                              {folder.shared_teams.map((team) => (
                                <div key={team.id} className="text-xs">• {team.name}</div>
                              ))}
                              {folder.shared_users && folder.shared_users.length > 0 && (
                                folder.shared_users.map((user) => (
                                  <div key={user.id} className="text-xs">• {user.name || user.email}</div>
                                ))
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
                  {/* TODO: Add bookmark_count when backend supports it */}
                  <p className="text-xs text-muted-foreground">—</p>
                </div>
              </Link>
              {folder.folder_type === 'own' && (
                <div className={`flex gap-1.5 pt-2.5 mt-auto border-t border-border ${compactMode ? 'pt-2' : ''}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Share2}
                    onClick={() => { setSharingFolder(folder); setShareDialogOpen(true); }}
                    title={t('sharing.shareFolder')}
                    className={`${compactMode ? 'text-xs px-2 py-1' : 'text-xs'}`}
                  />
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
                    {t('bookmarks.title')}
                  </th>
                )}
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
                    <Link
                      to={`${appBasePath}/bookmarks?folder_id=${folder.id}`}
                      className={`flex items-center ${compactMode ? 'gap-2' : 'gap-3'} hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded`}
                    >
                      <div className={`flex-shrink-0 ${compactMode ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-primary/20 flex items-center justify-center border border-primary/30`}>
                        <FolderIcon iconName={folder.icon} size={compactMode ? 12 : 16} className="text-primary" />
                      </div>
                      <div className={`font-medium text-gray-900 dark:text-white ${compactMode ? 'text-xs' : 'text-[15px]'}`}>
                        {folder.name}
                      </div>
                    </Link>
                  </td>
                  {!compactMode && (
                    <td className="px-4 py-3 text-xs text-muted-foreground">—</td>
                  )}
                  {!compactMode && (
                    <td className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'}`}>
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
                          icon={Share2}
                          onClick={() => { setSharingFolder(folder); setShareDialogOpen(true); }}
                          title={t('sharing.shareFolder')}
                          className={compactMode ? 'px-1 h-6' : 'px-2'}
                        />
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
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSuccess={loadData}
      />

      {sharingFolder && (
        <ShareResourceDialog
          resourceType="folder"
          resourceId={sharingFolder.id}
          resourceName={sharingFolder.name}
          isOpen={shareDialogOpen}
          onClose={() => { setShareDialogOpen(false); setSharingFolder(null); }}
          onSuccess={loadData}
        />
      )}

      <ConfirmDialog {...dialogState} />
    </div>
  );
}

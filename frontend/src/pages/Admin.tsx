import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, UserCog, Settings, Key, ExternalLink } from 'lucide-react';
import AdminUsers from '../components/admin/AdminUsers';
import AdminTeams from '../components/admin/AdminTeams';
import AdminOIDCProviders from '../components/admin/AdminOIDCProviders';
import AdminSettings from '../components/admin/AdminSettings';
import { isCloud } from '../config/mode';

type Tab = 'users' | 'teams' | 'oidc' | 'settings';

export default function Admin() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>('users');

  const allTabs = [
    { id: 'users' as Tab, label: t('admin.users'), icon: Users },
    { id: 'teams' as Tab, label: t('admin.teams'), icon: UserCog },
    { id: 'oidc' as Tab, label: t('admin.oidcProviders'), icon: Key },
    { id: 'settings' as Tab, label: t('admin.settings'), icon: Settings },
  ];
  const tabs = isCloud ? allTabs.filter((tab) => tab.id !== 'oidc') : allTabs;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">{t('admin.title')}</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('admin.description')}</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex space-x-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  relative inline-flex items-center gap-2 px-4 py-3 text-sm font-medium rounded-t-lg transition-colors
                  ${
                    activeTab === tab.id
                      ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  }
                `}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="mt-6">
        {activeTab === 'users' && <AdminUsers />}
        {activeTab === 'teams' && <AdminTeams />}
        {activeTab === 'oidc' && !isCloud && <AdminOIDCProviders />}
        {activeTab === 'settings' && <AdminSettings />}
      </div>

      {/* API Documentation Link */}
      <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('admin.apiDocsNote')}
            </p>
          </div>
          <a
            href="/api-docs"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            {t('admin.viewApiDocs')}
          </a>
        </div>
      </div>
    </div>
  );
}

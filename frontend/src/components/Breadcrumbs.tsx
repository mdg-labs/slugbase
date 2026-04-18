import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { useAppConfig } from '@/contexts/AppConfigContext';
import { cn } from '@/lib/utils';

function normalizePrefix(prefix: string): string {
  return (prefix || '').replace(/\/+/g, '/') || '';
}

function joinTo(prefix: string, pathFromRoot: string): string {
  const p = normalizePrefix(prefix);
  const path = pathFromRoot.startsWith('/') ? pathFromRoot : `/${pathFromRoot}`;
  if (path === '/' || path === '') return p || '/';
  if (!p) return path.replace(/\/+/g, '/');
  return `${p}${path}`.replace(/\/+/g, '/');
}

function labelForSegment(
  segment: string,
  segments: string[],
  index: number,
  t: (key: string) => string,
  extraAdminNavItems: { path: string; label: string }[] | undefined
): string {
  const adminChild = segments[0] === 'admin' && index > 0;

  if (adminChild) {
    switch (segment) {
      case 'members':
        return t('admin.users');
      case 'teams':
        return t('admin.teams');
      case 'oidc':
        return t('admin.oidcProviders');
      case 'settings':
        return t('admin.settings');
      case 'ai':
        return t('admin.ai.nav');
      default: {
        const extra = extraAdminNavItems?.find((e) => e.path === segment);
        if (extra) return extra.label;
      }
    }
  }

  switch (segment) {
    case 'admin':
      return t('admin.title');
    case 'bookmarks':
      return t('bookmarks.title');
    case 'folders':
      return t('folders.title');
    case 'tags':
      return t('tags.title');
    case 'profile':
      return t('profile.title');
    case 'go-preferences':
      return t('goPreferences.title');
    case 'search-engine-guide':
      return t('searchEngineGuide.title');
    default:
      return segment
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
  }
}

export function Breadcrumbs({ className }: { className?: string }) {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const { pathPrefixForLinks, extraAdminNavItems } = useAppConfig();
  const prefix = normalizePrefix(pathPrefixForLinks || '');

  const pathOnly = pathname.split('?')[0].replace(/\/+$/, '') || '/';
  const segments = pathOnly === '/' ? [] : pathOnly.split('/').filter(Boolean);

  const items: { label: string; to: string }[] =
    segments.length === 0
      ? [{ label: t('dashboard.overview'), to: joinTo(prefix, '/') }]
      : (() => {
          const out: { label: string; to: string }[] = [];
          let acc = '';
          for (let i = 0; i < segments.length; i++) {
            acc += `/${segments[i]}`;
            out.push({
              label: labelForSegment(segments[i], segments, i, t, extraAdminNavItems),
              to: joinTo(prefix, acc),
            });
          }
          return out;
        })();

  return (
    <nav aria-label="Breadcrumb" className={cn('crumbs flex min-w-0 items-center text-[12.5px]', className)}>
      <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0">
        <li className="flex shrink-0 items-center text-fg-2" aria-hidden>
          <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
        </li>
        {items.map((item, i) => (
          <li key={`${item.to}-${i}`} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && (
              <span className="shrink-0 text-fg-3" aria-hidden>
                /
              </span>
            )}
            {i === items.length - 1 ? (
              <span className="here truncate font-medium text-fg-0">{item.label}</span>
            ) : (
              <Link to={item.to} className="truncate font-medium text-fg-2 transition-colors hover:text-fg-0">
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

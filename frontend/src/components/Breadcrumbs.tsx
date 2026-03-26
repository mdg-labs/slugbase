import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
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
    case 'shared':
      return t('shared.title');
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
    <nav aria-label="Breadcrumb" className={cn('flex min-w-0 items-center text-sm text-muted-foreground', className)}>
      <ol className="flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0 m-0">
        {items.map((item, i) => (
          <li key={`${item.to}-${i}`} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-4 w-4 shrink-0 opacity-50" aria-hidden />}
            {i === items.length - 1 ? (
              <span className="truncate font-medium text-foreground">{item.label}</span>
            ) : (
              <Link to={item.to} className="truncate transition-colors hover:text-foreground">
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { useAppConfig } from '../contexts/AppConfigContext';
import { EmptyState } from '@/components/EmptyState';
import { buttonVariants } from '@/components/ui/button-base';
import { cn } from '@/lib/utils';

export default function NotFound() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const homeHref = useMemo(() => {
    const p = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
    if (!p) return '/';
    return p.endsWith('/') ? p : `${p}/`;
  }, [pathPrefixForLinks]);

  return (
    <div className="flex min-h-[50vh] w-full items-center justify-center px-4 py-16">
      <EmptyState
        icon={Compass}
        title={t('errors.notFoundTitle')}
        description={t('errors.notFoundBody')}
        action={
          <Link to={homeHref} className={cn(buttonVariants({ variant: 'primary', size: 'lg' }))}>
            {t('common.backToDashboard')}
          </Link>
        }
      />
    </div>
  );
}

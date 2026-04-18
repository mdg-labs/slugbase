import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Map } from 'lucide-react';
import { useAppConfig } from '../contexts/AppConfigContext';
import { EmptyState } from '@/components/EmptyState';
import { buttonVariants } from '@/components/ui/button-base';
import { cn } from '@/lib/utils';

export default function NotFound() {
  const { t } = useTranslation();
  const { appRootPath } = useAppConfig();

  return (
    <div className="flex min-h-[50vh] w-full items-center justify-center px-4 py-16">
      <EmptyState
        icon={Map}
        title={t('errors.notFoundTitle')}
        description={t('errors.notFoundBody')}
        action={
          <Link to={appRootPath} className={cn(buttonVariants({ variant: 'primary', size: 'lg' }))}>
            {t('common.backToDashboard')}
          </Link>
        }
      />
    </div>
  );
}

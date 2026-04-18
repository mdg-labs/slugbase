import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { authShell, authCard, authBrand } from '@/components/auth/authPageClasses';
import { cn } from '@/lib/utils';

export interface AuthCardLayoutProps {
  children: ReactNode;
  /** Max width in px — mockup card ~380–440 */
  width?: number;
  className?: string;
}

export function AuthCardLayout({ children, width = 440, className }: AuthCardLayoutProps) {
  const { t } = useTranslation();

  return (
    <div className={cn(authShell, 'flex flex-col items-center justify-center', className)}>
      <div className="w-full max-w-full px-1" style={{ maxWidth: width }}>
        <div className={authBrand}>
          <div className="grid size-[34px] place-items-center rounded-[9px] border border-[var(--accent-ring)] bg-[var(--accent-bg)]">
            <img src="/slugbase_icon_purple.svg" alt="" className="size-[22px]" width={22} height={22} />
          </div>
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--fg-0)]">{t('app.name')}</span>
        </div>
        <div className={authCard}>{children}</div>
      </div>
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { strength as strengthWrap, segBar, strengthLabel } from '@/components/auth/authPageClasses';

export interface PasswordStrengthMeterProps {
  /** 0–4 from `passwordStrengthScore` */
  score: 0 | 1 | 2 | 3 | 4;
  /** For signup aria-describedby / id */
  id?: string;
  className?: string;
}

function segmentTone(score: number, index: number): string {
  if (index >= score) return 'bg-[var(--bg-4)]';
  if (score <= 1) return 'bg-[var(--danger)]';
  if (score === 2) return 'bg-[var(--warn)]';
  if (score === 3) return 'bg-[var(--t-amber)]';
  return 'bg-[var(--success)]';
}

export function PasswordStrengthMeter({ score, id, className }: PasswordStrengthMeterProps) {
  const { t } = useTranslation();

  const label =
    score <= 0
      ? t('passwordStrength.tooShort')
      : score === 1
        ? t('passwordStrength.weak')
        : score === 2
          ? t('passwordStrength.fair')
          : score === 3
            ? t('passwordStrength.good')
            : t('passwordStrength.strong');

  return (
    <div className={cn(strengthWrap, className)}>
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn(segBar, segmentTone(score, i))} />
        ))}
      </div>
      <p id={id} className={strengthLabel} aria-live="polite">
        {label}
      </p>
    </div>
  );
}

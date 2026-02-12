import { useTranslation } from 'react-i18next';
import Button from './Button';
import { cn } from '@/lib/utils';

interface ModalFooterActionsProps {
  onCancel: () => void;
  cancelLabel?: string;
  submitLabel: string;
  loading?: boolean;
  submitDisabled?: boolean;
  submitVariant?: 'primary' | 'danger';
  formId?: string;
  className?: string;
}

export function ModalFooterActions({
  onCancel,
  cancelLabel,
  submitLabel,
  loading = false,
  submitDisabled = false,
  submitVariant = 'primary',
  formId,
  className,
}: ModalFooterActionsProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'flex flex-row justify-between gap-2 sm:justify-end',
        className
      )}
    >
      <Button variant="secondary" onClick={onCancel} type="button">
        {cancelLabel ?? t('common.cancel')}
      </Button>
      <Button
        variant={submitVariant}
        loading={loading}
        disabled={submitDisabled || loading}
        type="submit"
        form={formId}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

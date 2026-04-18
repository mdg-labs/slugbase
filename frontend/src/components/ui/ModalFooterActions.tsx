import { useTranslation } from 'react-i18next';
import Button from './Button';
import { cn } from '@/lib/utils';

interface ModalFooterActionsProps {
  onCancel: () => void;
  cancelLabel?: string;
  cancelVariant?: 'outline' | 'ghost';
  submitLabel: string;
  loading?: boolean;
  submitDisabled?: boolean;
  submitVariant?: 'primary' | 'danger';
  formId?: string;
  className?: string;
}

/** Trailing ghost + primary — use inside `ModalFoot` / `DialogFooter` for mockup `.modal-foot` padding. */
export function ModalFooterActions({
  onCancel,
  cancelLabel,
  cancelVariant = 'ghost',
  submitLabel,
  loading = false,
  submitDisabled = false,
  submitVariant = 'primary',
  formId,
  className,
}: ModalFooterActionsProps) {
  const { t } = useTranslation();

  return (
    <div className={cn('flex w-full flex-wrap items-center justify-end gap-2', className)}>
      <Button variant={cancelVariant} onClick={onCancel} type="button" size="md">
        {cancelLabel ?? t('common.cancel')}
      </Button>
      <Button
        variant={submitVariant}
        loading={loading}
        disabled={submitDisabled || loading}
        type="submit"
        form={formId}
        size="md"
      >
        {submitLabel}
      </Button>
    </div>
  );
}

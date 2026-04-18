import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  ModalContent,
  ModalBody,
  ModalFoot,
} from './dialog';
import { Input } from './input';
import Button from './Button';
import { cn } from '@/lib/utils';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  itemName?: string;
  /** Optional monospace bullet lines (last line may use --danger via `dangerLast`). */
  impactLines?: string[];
  /** When true, the last impact line is styled with `--danger`. */
  dangerLast?: boolean;
  /** Exact string the user must type to enable confirm (opt-in destructive flows). */
  requireType?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  isOpen,
  title,
  message,
  itemName,
  impactLines,
  dangerLast = true,
  requireType,
  confirmText,
  cancelText,
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (isOpen) {
      setTyped('');
    }
  }, [isOpen, requireType]);

  const typeOk = !requireType || typed.trim() === requireType;
  const isDanger = variant === 'danger';

  function handleConfirmClick() {
    if (!typeOk) return;
    onConfirm();
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <ModalContent
        className="max-w-[440px] w-[min(440px,92vw)]"
        hideCloseButton
        aria-describedby={undefined}
      >
        <div
          className={cn(
            'modal-head flex shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-[18px] py-3.5'
          )}
        >
          <span
            className={cn(
              'flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-sm)] ring-1 ring-inset',
              isDanger
                ? 'bg-[rgba(248,113,113,.1)] text-[var(--danger)] ring-[rgba(248,113,113,.25)]'
                : 'bg-[var(--accent-bg)] text-[var(--accent-hi)] ring-[var(--accent-ring)]'
            )}
          >
            <AlertTriangle className="size-[13px]" strokeWidth={1.75} aria-hidden />
          </span>
          <DialogPrimitive.Title asChild>
            <h3 className="m-0 text-sm font-semibold leading-none text-[var(--fg-0)]">{title}</h3>
          </DialogPrimitive.Title>
          <DialogPrimitive.Close
            type="button"
            className="close ml-auto rounded p-1 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
            aria-label={t('common.close')}
          >
            <X className="size-3.5" strokeWidth={2} aria-hidden />
            <span className="sr-only">{t('common.close')}</span>
          </DialogPrimitive.Close>
        </div>

        <ModalBody>
          <p className="text-[13px] leading-relaxed text-[var(--fg-1)]">
            {message}
            {itemName ? (
              <>
                {' '}
                <strong className="font-semibold text-[var(--fg-0)]">{itemName}</strong>
              </>
            ) : null}
          </p>

          {impactLines && impactLines.length > 0 ? (
            <div className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2.5 font-mono text-[12px] leading-snug text-[var(--fg-1)]">
              <ul className="list-none space-y-1">
                {impactLines.map((line, i) => (
                  <li
                    key={i}
                    className={
                      dangerLast && i === impactLines.length - 1 ? 'text-[var(--danger)]' : undefined
                    }
                  >
                    • {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {requireType ? (
            <div className="mt-4 space-y-1.5">
              <p className="text-[12.5px] leading-snug text-[var(--fg-1)]">
                {t('confirm.typeInstructionBefore')}
                <code className="mx-0.5 rounded bg-[var(--bg-2)] px-1 font-mono text-[12px] text-[var(--danger)]">
                  {requireType}
                </code>
                {t('confirm.typeInstructionAfter')}
              </p>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                aria-invalid={!typeOk}
                className={cn(
                  'border-[rgba(248,113,113,0.3)] focus-within:border-[rgba(248,113,113,0.45)] focus-within:shadow-none'
                )}
              />
            </div>
          ) : null}
        </ModalBody>

        <ModalFoot>
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" type="button" size="md" onClick={onCancel}>
              {cancelText ?? t('common.cancel')}
            </Button>
            <Button
              variant={variant === 'danger' ? 'danger' : 'primary'}
              type="button"
              size="md"
              disabled={!typeOk}
              onClick={handleConfirmClick}
            >
              {confirmText ?? t('common.confirm')}
            </Button>
          </div>
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

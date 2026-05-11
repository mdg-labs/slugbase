import { useId, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Shield } from 'lucide-react';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
import Button from '../ui/Button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { useToast } from '../ui/Toast';
import { copyTextToClipboard } from '../../utils/copyTextToClipboard';

export interface MfaEnrollSetupModalProps {
  open: boolean;
  otpauthUrl: string;
  secretB32: string;
  confirmCode: string;
  onConfirmCodeChange: (value: string) => void;
  error: string;
  busy: boolean;
  onSubmit: (e: FormEvent) => void;
  /** Called when the user dismisses the dialog (overlay, Escape, X) or clicks Cancel setup. */
  onCancelSetup: () => void | Promise<void>;
}

export default function MfaEnrollSetupModal({
  open,
  otpauthUrl,
  secretB32,
  confirmCode,
  onConfirmCodeChange,
  error,
  busy,
  onSubmit,
  onCancelSetup,
}: MfaEnrollSetupModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const fieldId = useId();
  const formId = `${fieldId}-mfa-enroll`;

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      void onCancelSetup();
    }
  };

  const copySecret = async () => {
    const ok = await copyTextToClipboard(secretB32);
    if (ok) {
      showToast(t('mfa.secretCopied'), 'success');
    } else {
      showToast(t('mfa.copyFailed'), 'error');
    }
  };

  return (
    <Modal open={open} onOpenChange={handleOpenChange}>
      <ModalContent className="flex max-w-[380px] flex-col p-0" aria-describedby={undefined}>
        <ModalHead icon={Shield} title={t('mfa.enrollSetupTitle')} />

        <form id={formId} onSubmit={onSubmit}>
          <ModalBody>
            <p className="-mt-1 mb-4 text-[12.5px] text-[var(--fg-2)]">{t('mfa.scanQrOrEnterSecret')}</p>

            <div className="flex justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-white p-4">
              <QRCodeSVG value={otpauthUrl} size={200} level="M" title={t('mfa.qrAlt')} />
            </div>

            <div className="space-y-2 pt-4">
              <Label className="text-[12.5px] font-medium text-[var(--fg-0)]">{t('mfa.manualSecret')}</Label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="block flex-1 break-all rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 font-mono text-[11px] text-[var(--fg-0)]">
                  {secretB32}
                </code>
                <Button type="button" variant="secondary" size="sm" onClick={() => void copySecret()} disabled={busy}>
                  {t('mfa.copySecret')}
                </Button>
              </div>
            </div>

            <div className="space-y-2 pt-4">
              <Label htmlFor={`${fieldId}-confirm-code`} className="text-[12.5px]">
                {t('mfa.confirmCodeLabel')}
              </Label>
              <Input
                id={`${fieldId}-confirm-code`}
                name="mfa-confirm"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={12}
                value={confirmCode}
                onChange={(e) => onConfirmCodeChange(e.target.value)}
                placeholder={t('mfa.codePlaceholder')}
                disabled={busy}
                aria-invalid={Boolean(error)}
                className="max-w-xs font-mono"
              />
            </div>
            {error ? (
              <p id={`${fieldId}-wizard-err`} className="pt-2 text-sm text-[var(--danger)]" role="alert" aria-live="assertive">
                {error}
              </p>
            ) : null}
          </ModalBody>

          <ModalFoot className="justify-between sm:justify-end">
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void onCancelSetup()}>
                {t('mfa.cancelSetup')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={busy}
              >
                {busy ? t('common.loading') : t('mfa.confirmEnrollment')}
              </Button>
            </div>
          </ModalFoot>
        </form>
      </ModalContent>
    </Modal>
  );
}

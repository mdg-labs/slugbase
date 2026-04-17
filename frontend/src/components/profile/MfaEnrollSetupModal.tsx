import { useId, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Shield } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" aria-hidden />
            {t('mfa.enrollSetupTitle')}
          </DialogTitle>
          <DialogDescription>{t('mfa.scanQrOrEnterSecret')}</DialogDescription>
        </DialogHeader>

        <div className="flex justify-center rounded-xl border border-ghost bg-surface-low p-4">
          <QRCodeSVG value={otpauthUrl} size={200} level="M" title={t('mfa.qrAlt')} />
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium">{t('mfa.manualSecret')}</Label>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <code className="block flex-1 break-all rounded-lg border border-ghost bg-surface-low px-3 py-2 text-xs font-mono">
              {secretB32}
            </code>
            <Button type="button" variant="secondary" size="sm" onClick={() => void copySecret()} disabled={busy}>
              {t('mfa.copySecret')}
            </Button>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-confirm-code`}>{t('mfa.confirmCodeLabel')}</Label>
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
              className="max-w-xs"
            />
          </div>
          {error ? (
            <p id={`${fieldId}-wizard-err`} className="text-sm text-destructive" role="alert" aria-live="assertive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void onCancelSetup()}>
              {t('mfa.cancelSetup')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy}
              className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
            >
              {busy ? t('common.loading') : t('mfa.confirmEnrollment')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

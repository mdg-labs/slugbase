import { useId } from 'react';
import { useTranslation } from 'react-i18next';
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
import { Label } from '../ui/label';
import { useToast } from '../ui/Toast';
import { copyTextToClipboard } from '../../utils/copyTextToClipboard';

export interface MfaEnrollBackupCodesModalProps {
  open: boolean;
  codes: string[];
  ack: boolean;
  onAckChange: (checked: boolean) => void;
  busy: boolean;
  onContinue: () => void | Promise<void>;
}

export default function MfaEnrollBackupCodesModal({
  open,
  codes,
  ack,
  onAckChange,
  busy,
  onContinue,
}: MfaEnrollBackupCodesModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const fieldId = useId();

  const copyAll = async () => {
    const ok = await copyTextToClipboard(codes.join('\n'));
    if (ok) {
      showToast(t('mfa.backupCodesCopied'), 'success');
    } else {
      showToast(t('mfa.copyFailed'), 'error');
    }
  };

  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-md max-h-[90vh] overflow-y-auto"
        hideCloseButton
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" aria-hidden />
            {t('mfa.enrollBackupTitle')}
          </DialogTitle>
          <DialogDescription>{t('mfa.backupCodesWarning')}</DialogDescription>
        </DialogHeader>

        <ul className="grid gap-1 rounded-lg border border-ghost bg-surface-low p-3 font-mono text-sm max-h-48 overflow-auto" role="list">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void copyAll()} disabled={busy}>
            {t('mfa.copyAllBackupCodes')}
          </Button>
        </div>

        <div className="flex items-start gap-2">
          <input
            id={`${fieldId}-ack`}
            type="checkbox"
            checked={ack}
            onChange={(e) => onAckChange(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-ghost"
          />
          <Label htmlFor={`${fieldId}-ack`} className="text-sm font-normal leading-snug cursor-pointer">
            {t('mfa.backupCodesAck')}
          </Label>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="primary"
            disabled={!ack || busy}
            className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
            onClick={() => void onContinue()}
          >
            {busy ? t('common.loading') : t('mfa.backupCodesContinue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

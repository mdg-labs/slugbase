import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Key } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Modal,
  ModalContent,
  ModalBody,
  ModalFoot,
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

  function downloadTxt() {
    const blob = new Blob([codes.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'slugbase-mfa-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  function printCodes() {
    const w = window.open('', '_blank', 'noopener');
    if (!w) return;
    w.document.write(`<pre style="font:14px monospace;padding:24px">${codes.map((c) => c.replace(/</g, '&lt;')).join('\n')}</pre>`);
    w.document.close();
    w.print();
    w.close();
  }

  return (
    <Modal open={open}>
      <ModalContent
        className="flex max-w-[380px] flex-col p-0"
        hideCloseButton
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        aria-describedby={undefined}
      >
        <div className="modal-head flex shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-[18px] py-3.5">
          <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent-bg)] text-[var(--accent-hi)] ring-1 ring-inset ring-[var(--accent-ring)]">
            <Key className="size-[13px]" strokeWidth={1.75} aria-hidden />
          </span>
          <DialogPrimitive.Title asChild>
            <h3 className="m-0 text-sm font-semibold leading-none text-[var(--fg-0)]">{t('mfa.enrollBackupTitle')}</h3>
          </DialogPrimitive.Title>
        </div>

        <ModalBody>
          <p className="-mt-1 mb-4 text-[12.5px] text-[var(--fg-2)]">{t('mfa.backupCodesWarning')}</p>

          <ul
            className="code-grid grid max-h-48 grid-cols-2 gap-x-4 gap-y-1 overflow-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] p-3 font-mono text-[12px] text-[var(--fg-0)]"
            role="list"
          >
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => void copyAll()} disabled={busy}>
              {t('mfa.copyAllBackupCodes')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={downloadTxt} disabled={busy}>
              {t('mfa.downloadBackupTxt')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={printCodes} disabled={busy}>
              {t('mfa.printBackupCodes')}
            </Button>
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-sm)] border border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.08)] px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <input
                  id={`${fieldId}-ack`}
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => onAckChange(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-[var(--border)]"
                />
                <Label htmlFor={`${fieldId}-ack`} className="cursor-pointer text-[12.5px] font-normal leading-snug text-[var(--fg-1)]">
                  {t('mfa.backupCodesAck')}
                </Label>
              </div>
            </div>
          </div>
        </ModalBody>

        <ModalFoot>
          <Button
            type="button"
            variant="primary"
            disabled={!ack || busy}
            onClick={() => void onContinue()}
          >
            {busy ? t('common.loading') : t('mfa.backupCodesContinue')}
          </Button>
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}

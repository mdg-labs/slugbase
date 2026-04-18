import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Key, Copy, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Separator } from '../ui/separator';
import { FormFieldWrapper } from '../ui/FormFieldWrapper';
import { ModalSection } from '../ui/ModalSection';
import { ModalFooterActions } from '../ui/ModalFooterActions';
import { Input } from '../ui/input';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import api from '../../api/client';
import { copyTextToClipboard } from '../../utils/copyTextToClipboard';

interface CreateTokenModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}

type Step = 'form' | 'reveal';

export default function CreateTokenModal({ isOpen, onClose, onCreated }: CreateTokenModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>('form');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setStep('form');
    setName('');
    setError(null);
    setToken(null);
    setCopied(false);
  }

  function handleClose() {
    reset();
    onClose();
    if (step === 'reveal') {
      onCreated();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await api.post('/tokens', { name: name.trim() });
      setToken(res.data.token);
      setStep('reveal');
    } catch (err: any) {
      setError(err.response?.data?.error || t('common.error'));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!token) return;
    const ok = await copyTextToClipboard(token);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      showToast(t('common.copied'), 'success');
    } else {
      showToast(t('common.error'), 'error');
    }
  }

  const isValid = name.trim().length > 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-4 w-4 text-primary" />
            {step === 'form' ? t('profile.createToken') : t('profile.tokenCreated')}
          </DialogTitle>
        </DialogHeader>
        <Separator />

        {step === 'form' ? (
          <>
            <form id="create-token-form" onSubmit={handleSubmit} className="space-y-6">
              <ModalSection description={t('profile.apiAccessDescription')}>
                <FormFieldWrapper
                  label={t('profile.tokenName')}
                  required
                  error={error || undefined}
                  htmlFor="token-name"
                >
                  <Input
                    id="token-name"
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('profile.tokenNamePlaceholder')}
                    maxLength={100}
                  />
                </FormFieldWrapper>
              </ModalSection>
            </form>
            <Separator />
            <DialogFooter className="flex-row justify-between sm:justify-end gap-2">
              <ModalFooterActions
                onCancel={handleClose}
                submitLabel={t('profile.createToken')}
                loading={creating}
                submitDisabled={!isValid}
                formId="create-token-form"
              />
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground">
                  {t('profile.tokenRevealWarning')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={token || ''}
                  className="font-mono text-sm truncate bg-surface-low border border-ghost"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  icon={Copy}
                >
                  {copied ? t('common.success') : t('profile.copyToken')}
                </Button>
              </div>
            </div>
            <Separator />
            <DialogFooter className="flex-row justify-end">
              <Button type="button" variant="primary" onClick={handleClose} className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90">
                {t('common.close')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

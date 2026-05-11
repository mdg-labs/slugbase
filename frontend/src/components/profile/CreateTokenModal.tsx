import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Copy, Key } from 'lucide-react';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
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
  const [tokenVisible, setTokenVisible] = useState(false);

  function reset() {
    setStep('form');
    setName('');
    setError(null);
    setToken(null);
    setCopied(false);
    setTokenVisible(false);
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
    <Modal open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <ModalContent className="flex max-w-md flex-col p-0">
        <ModalHead
          icon={Key}
          title={step === 'form' ? t('profile.createToken') : t('profile.tokenCreated')}
        />

        {step === 'form' ? (
          <>
            <ModalBody>
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
            </ModalBody>
            <ModalFoot>
              <ModalFooterActions
                onCancel={handleClose}
                submitLabel={t('profile.createToken')}
                loading={creating}
                submitDisabled={!isValid}
                formId="create-token-form"
              />
            </ModalFoot>
          </>
        ) : (
          <>
            <ModalBody>
              <div className="space-y-4">
                <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.08)] px-3 py-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn)]" />
                  <p className="text-[12.5px] text-[var(--fg-1)]">{t('profile.tokenRevealWarning')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    readOnly
                    type={tokenVisible ? 'text' : 'password'}
                    value={token || ''}
                    className="min-w-0 flex-1 font-mono text-[12px]"
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => setTokenVisible((v) => !v)}>
                    {tokenVisible ? t('common.hidePassword') : t('common.showPassword')}
                  </Button>
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
            </ModalBody>
            <ModalFoot>
              <Button type="button" variant="primary" size="md" onClick={handleClose}>
                {t('common.close')}
              </Button>
            </ModalFoot>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

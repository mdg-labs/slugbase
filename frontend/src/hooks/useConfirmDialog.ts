import { useState, useCallback } from 'react';

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  itemName?: string;
  impactLines?: string[];
  dangerLast?: boolean;
  requireType?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'default';
  onConfirm: () => void;
}

export function useConfirmDialog() {
  const [dialogState, setDialogState] = useState<ConfirmDialogState>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const showConfirm = useCallback((
    title: string,
    message: string,
    onConfirm: () => void,
    options?: {
      itemName?: string;
      impactLines?: string[];
      dangerLast?: boolean;
      requireType?: string;
      confirmText?: string;
      cancelText?: string;
      variant?: 'danger' | 'warning' | 'default';
    }
  ) => {
    setDialogState({
      isOpen: true,
      title,
      message,
      onConfirm,
      itemName: options?.itemName,
      impactLines: options?.impactLines,
      dangerLast: options?.dangerLast,
      requireType: options?.requireType,
      confirmText: options?.confirmText,
      cancelText: options?.cancelText,
      variant: options?.variant || 'default',
    });
  }, []);

  const hideConfirm = useCallback(() => {
    setDialogState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const handleConfirm = useCallback(() => {
    dialogState.onConfirm();
    hideConfirm();
  }, [dialogState, hideConfirm]);

  return {
    showConfirm,
    hideConfirm,
    dialogState: {
      ...dialogState,
      onConfirm: handleConfirm,
      onCancel: hideConfirm,
    },
  };
}

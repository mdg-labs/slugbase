import { toast as sonnerToast } from 'sonner';
import { Toaster } from './sonner';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  duration?: number;
}

export function useToast() {
  const showToast = (
    message: string,
    variant: ToastVariant = 'info',
    duration = 3000
  ) => {
    const options = duration > 0 ? { duration } : { duration: Infinity };
    switch (variant) {
      case 'success':
        sonnerToast.success(message, options);
        break;
      case 'error':
        sonnerToast.error(message, options);
        break;
      case 'warning':
        sonnerToast.warning(message, options);
        break;
      case 'info':
      default:
        sonnerToast.info(message, options);
        break;
    }
  };

  return { showToast };
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}

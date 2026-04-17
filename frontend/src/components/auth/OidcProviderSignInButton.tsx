import { Key } from 'lucide-react';
import Button from '../ui/Button';
import { cn } from '@/lib/utils';

/** Human-readable name for common IdPs (avoids raw `google` in the UI). */
export function formatOidcProviderDisplayName(providerKey: string): string {
  const k = providerKey.toLowerCase();
  if (k === 'google') return 'Google';
  if (k === 'microsoft' || k === 'azuread') return 'Microsoft';
  return providerKey.charAt(0).toUpperCase() + providerKey.slice(1).toLowerCase();
}

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export interface OidcProviderSignInButtonProps {
  providerKey: string;
  label: string;
  onClick: () => void;
}

/**
 * Google: recognizable “Sign in with Google” look (logo + light surface) while matching SlugBase
 * auth card rhythm (rounded-xl, focus ring). Other providers keep the secondary + key icon pattern.
 */
export function OidcProviderSignInButton({ providerKey, label, onClick }: OidcProviderSignInButtonProps) {
  const isGoogle = providerKey.toLowerCase() === 'google';

  if (isGoogle) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex h-11 w-full items-center justify-center gap-3 rounded-xl border px-4 text-[15px] font-medium shadow-sm transition-colors',
          'border-[#dadce0] bg-white text-[#3c4043]',
          'hover:bg-[#f8f9fa] hover:border-[#dadce0]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'dark:border-zinc-500 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white'
        )}
      >
        <GoogleMark className="h-[18px] w-[18px] shrink-0" />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <Button variant="secondary" icon={Key} onClick={onClick} className="w-full border-ghost bg-surface-high">
      {label}
    </Button>
  );
}

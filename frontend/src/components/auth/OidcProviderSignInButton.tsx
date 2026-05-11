import { Key } from 'lucide-react';
import { cn } from '@/lib/utils';
import { oauthBtn } from '@/components/auth/authPageClasses';

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
 * Mockup `oauth-btn`: full-width, provider mark + label + monospace tail (OIDC / SSO).
 */
export function OidcProviderSignInButton({ providerKey, label, onClick }: OidcProviderSignInButtonProps) {
  const isGoogle = providerKey.toLowerCase() === 'google';

  if (isGoogle) {
    return (
      <button type="button" onClick={onClick} className={cn(oauthBtn, 'pl-3')}>
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <GoogleMark className="h-[18px] w-[18px] shrink-0" />
          <span className="truncate">{label}</span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--fg-3)]">Google</span>
      </button>
    );
  }

  return (
    <button type="button" onClick={onClick} className={cn(oauthBtn, 'pl-3')}>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <Key className="h-4 w-4 shrink-0 text-[var(--accent-hi)]" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--fg-3)]">OIDC</span>
    </button>
  );
}

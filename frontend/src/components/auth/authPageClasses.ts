/** Shared layout + field styling for Login and Signup (keep pages visually in sync). */

export const AUTH_PAGE_OUTER =
  'auth-page-bg flex min-h-screen min-h-dvh flex-col items-center justify-center px-4 py-8 sm:px-6 sm:py-10 lg:px-8';

export const AUTH_PAGE_INNER = 'w-full max-w-lg space-y-8';

export const AUTH_CARD_CLASS = 'rounded-xl border border-ghost bg-surface p-7 shadow-none';

/** Extra classes for <Input> on auth pages only (visible border + accent focus). */
export const AUTH_INPUT_CLASS =
  'border-ghost focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30';

export const AUTH_CROSS_LINK_FOOTER = 'mt-5 text-center text-sm text-muted-foreground';

export const AUTH_CROSS_LINK =
  'text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded';

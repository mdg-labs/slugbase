import * as Sentry from '@sentry/react';

/**
 * Floating debug buttons for Sentry testing.
 * Only visible when VITE_SENTRY_DEBUG=true at build time.
 */
export function SentryDebug() {
  if (import.meta.env.VITE_SENTRY_DEBUG !== 'true') return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex gap-2">
      <button
        type="button"
        onClick={() => {
          throw new Error('Sentry frontend test error (throw)');
        }}
        className="px-3 py-1.5 text-sm rounded-md bg-red-100 dark:bg-red-900/80 text-red-800 dark:text-red-200 hover:opacity-90"
      >
        Test Sentry (throw)
      </button>
      <button
        type="button"
        onClick={() => {
          Sentry.captureException(new Error('Sentry frontend test (capture)'));
        }}
        className="px-3 py-1.5 text-sm rounded-md bg-amber-100 dark:bg-amber-900/80 text-amber-800 dark:text-amber-200 hover:opacity-90"
      >
        Test Sentry (capture)
      </button>
    </div>
  );
}

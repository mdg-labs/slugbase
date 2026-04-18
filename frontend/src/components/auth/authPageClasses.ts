/**
 * Shared layout + field styling for auth pages (mockup §5.15).
 * Legacy exports kept so imports keep resolving during migration.
 */

/* --- Split-screen (Login / Signup) --- */
export const authWrap =
  'grid min-h-screen min-h-dvh w-full grid-cols-1 bg-[var(--bg-0)] min-[901px]:grid-cols-2';

export const authFormSide =
  'flex min-h-screen min-h-dvh flex-col border-[var(--border)] bg-[var(--bg-0)] px-8 py-8 min-[901px]:min-h-0 min-[901px]:border-r min-[901px]:px-12';

export const authFormInner =
  'mx-auto flex min-h-0 w-full max-w-[440px] flex-1 flex-col';

export const authTop =
  'mb-8 flex shrink-0 items-center justify-between gap-4';

export const authTitle =
  'text-[26px] font-semibold tracking-[-0.02em] text-[var(--fg-0)]';

export const authSub = 'mt-2 text-[13.5px] leading-relaxed text-[var(--fg-2)]';

export const oauthRow = 'flex flex-col gap-3';

export const oauthBtn =
  'flex w-full items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-2)] px-4 py-3 text-left text-[13px] font-medium text-[var(--fg-0)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-0)]';

export const dividerLbl =
  'my-6 flex items-center gap-3 text-[11px] font-mono uppercase tracking-[0.06em] text-[var(--fg-3)] before:h-px before:flex-1 before:bg-[var(--border)] after:h-px after:flex-1 after:bg-[var(--border)]';

export const authField = 'space-y-2';

export const authFieldLabel =
  'font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--fg-3)]';

export const authInput =
  'flex h-11 w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 text-[13px] text-[var(--fg-0)] shadow-sm transition-[border-color,box-shadow] focus-within:border-[var(--accent-ring)] focus-within:shadow-[0_0_0_3px_var(--accent-bg)]';

export const authInputInvalid = 'border-[rgba(248,113,113,0.5)]';

export const fieldError = 'text-[11px] font-medium text-[var(--danger)]';

export const strength = 'mt-2 space-y-2';

export const segBar = 'h-2 min-h-0 flex-1 rounded-[3px] transition-colors';

export const strengthLabel = 'text-[11px] leading-snug text-[var(--fg-2)]';

export const checkboxRow = 'flex items-start gap-3';

export const checkbox =
  'mt-0.5 size-4 shrink-0 rounded border border-[var(--border-strong)] bg-[var(--bg-2)] text-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

/** Applied when the legal-acceptance checkbox is checked (see Signup). */
export const checkboxOn = 'border-[var(--accent-ring)] bg-[var(--accent-bg)]';

export const authSubmit =
  'flex h-11 w-full items-center justify-between gap-2 rounded-lg border-0 bg-[var(--accent)] px-4 text-[13px] font-semibold text-white shadow-sm transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-0)] disabled:opacity-60';

export const authFooter =
  'flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-[var(--border-soft)] pt-8 text-[11.5px] text-[var(--fg-3)]';

export const switchTabs =
  'mb-8 flex rounded-lg border border-[var(--border)] bg-[var(--bg-2)] p-1 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--fg-3)]';

export const switchTabBtn = (active: boolean) =>
  [
    'flex-1 rounded-md px-3 py-2 text-center transition-colors',
    active
      ? 'bg-[var(--bg-3)] text-[var(--fg-0)] shadow-sm'
      : 'text-[var(--fg-3)] hover:text-[var(--fg-1)]',
  ].join(' ');

/* --- Centered card (MFA, reset, verify, etc.) --- */
export const authShell =
  'min-h-screen min-h-dvh w-full px-6 py-10 bg-[radial-gradient(circle_at_20%_0%,rgba(123,126,244,0.08),transparent_40%),radial-gradient(circle_at_80%_100%,rgba(217,140,244,0.06),transparent_40%),var(--bg-0)]';

export const authCard =
  'w-full max-w-[440px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-7 shadow-[var(--shadow-lg)]';

export const authBrand =
  'mb-6 flex items-center gap-2.5';

export const otpGroup = 'my-5 flex justify-center gap-2';

export const otpInput =
  'h-[50px] w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)] text-center font-mono text-lg font-semibold tracking-[0.5em] text-[var(--fg-0)]';

export const codeGrid = 'grid grid-cols-2 gap-2 font-mono text-[13px] text-[var(--fg-1)]';

export const codeItem = 'rounded-md bg-[var(--bg-2)] px-2 py-1.5';

/* --- Legacy aliases (Login/Signup pre-refactor) --- */
export const AUTH_PAGE_OUTER = authShell;

export const AUTH_PAGE_INNER = 'w-full max-w-lg space-y-8';

export const AUTH_CARD_CLASS =
  'rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-7 shadow-none';

/** @deprecated Prefer `authInput` shell — kept for Input add-on classes */
export const AUTH_INPUT_CLASS =
  'border-[var(--border)] focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]/30';

export const AUTH_CROSS_LINK_FOOTER = 'mt-5 text-center text-sm text-[var(--fg-2)]';

export const AUTH_CROSS_LINK =
  'font-medium text-[var(--accent-hi)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-0)] rounded';

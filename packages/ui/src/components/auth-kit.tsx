import type { ReactNode } from "react";

/* ── Brand rail labels (caller supplies translated strings) ── */

export type AuthShellBrandLabels = {
  headline: string;
  subline: string;
  footer: string;
};

export type AuthShellProps = {
  children: ReactNode;
  brand: AuthShellBrandLabels;
  /** Setup wizard omits slug rows in the brand rail (spec §8.3) */
  showSlugRows?: boolean;
  /** Brand icon URL (web serves `/slugbase_icon.svg`) */
  iconSrc?: string;
};

/**
 * Shared two-pane auth layout (prototype AuthKit.jsx / auth.css).
 * Left pane: brand rail (gradient wash, hero, optional slug rows).
 * Right pane: form card at min(404px, 100%).
 * Grid: minmax(440px, 0.9fr) 1fr; brand hidden below 920px.
 */
export function AuthShell({
  children,
  brand,
  showSlugRows = true,
  iconSrc = "/slugbase_icon.svg",
}: AuthShellProps) {
  return (
    <div
      className="min-h-screen bg-canvas font-sans grid grid-cols-1 min-[920px]:grid-cols-[minmax(440px,0.9fr)_1fr]"
      data-testid="auth-shell"
    >
      <aside
        className="relative overflow-hidden hidden min-[920px]:flex flex-col justify-between border-r border-[color:var(--border-subtle)] bg-base"
        style={{ padding: "var(--sp-11) var(--sp-11) var(--sp-10)", gap: "var(--sp-8)" }}
        aria-hidden="true"
        data-testid="auth-shell-brand-rail"
      >
        <div
          className="absolute pointer-events-none"
          style={{
            top: "-180px",
            left: "-140px",
            width: "460px",
            height: "460px",
            background: "radial-gradient(circle, var(--accent-subtle) 0%, transparent 68%)",
          }}
        />

        <div className="relative flex items-center" style={{ gap: "var(--sp-4)" }}>
          <img src={iconSrc} alt="" width={30} height={30} className="shrink-0" />
          <span
            className="text-fg"
            style={{
              fontWeight: "var(--weight-semi)",
              fontSize: "var(--text-h2)",
              lineHeight: "var(--lh-h2)",
              letterSpacing: "var(--track-tight)",
            }}
          >
            SlugBase
          </span>
        </div>

        <div
          className="relative flex flex-col flex-1 justify-center"
          style={{ gap: "var(--sp-8)" }}
        >
          <div style={{ maxWidth: "30ch" }}>
            <h1
              className="text-fg"
              style={{
                margin: 0,
                marginBottom: "var(--sp-5)",
                fontWeight: "var(--weight-semi)",
                fontSize: "var(--text-display)",
                lineHeight: "var(--lh-display)",
                letterSpacing: "var(--track-tight)",
              }}
            >
              {brand.headline}
            </h1>
            <p
              className="text-fg-muted"
              style={{ margin: 0, fontSize: "var(--text-body-lg)", lineHeight: "var(--lh-body-lg)" }}
            >
              {brand.subline}
            </p>
          </div>

          {showSlugRows && (
            <div className="relative flex flex-col" style={{ gap: "var(--sp-3)" }}>
              <BrandSlugRow src="go.slugbase.app/react19" dst="react.dev/blog" opacity={1} />
              <BrandSlugRow src="go.slugbase.app/ddia" dst="dataintensive.net" opacity={0.55} />
              <BrandSlugRow
                src="go.slugbase.app/rustperf"
                dst="nnethercote.github.io"
                opacity={0.28}
              />
            </div>
          )}
        </div>

        <p
          className="relative text-fg-subtle"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {brand.footer}
        </p>
      </aside>

      <div
        className="grid place-items-center"
        style={{ padding: "var(--sp-9) var(--sp-8)" }}
        data-testid="auth-shell-form-pane"
      >
        <div style={{ width: "min(404px, 100%)" }}>
          <div
            className="flex min-[920px]:hidden items-center"
            style={{ gap: "var(--sp-4)", marginBottom: "var(--sp-8)" }}
          >
            <img src={iconSrc} alt="" width={26} height={26} className="shrink-0" />
            <span
              className="text-fg"
              style={{ fontWeight: "var(--weight-semi)", fontSize: "var(--text-h3)" }}
            >
              SlugBase
            </span>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}

function BrandSlugRow({
  src,
  dst,
  opacity,
}: {
  src: string;
  dst: string;
  opacity: number;
}) {
  return (
    <div
      className="flex items-center border border-[color:var(--border-subtle)] bg-raised"
      style={{
        opacity,
        padding: "var(--sp-4) var(--sp-5)",
        borderRadius: "var(--r-lg)",
        gap: "var(--sp-4)",
        fontFamily: "var(--font-mono)",
        fontWeight: "var(--weight-medium)",
        fontSize: "var(--text-mono)",
        lineHeight: 1,
      }}
    >
      <span className="text-accent-text shrink-0">{src}</span>
      <span className="text-fg-faint shrink-0">
        <ArrowRightIcon />
      </span>
      <span className="text-fg-subtle overflow-hidden text-ellipsis whitespace-nowrap">{dst}</span>
    </div>
  );
}

function ArrowRightIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export function AuthInput({
  leadingIcon,
  trailingSlot,
  className,
  style,
  ...inputProps
}: React.InputHTMLAttributes<HTMLInputElement> & {
  leadingIcon?: ReactNode;
  trailingSlot?: ReactNode;
}) {
  const paddingLeft = leadingIcon ? "calc(var(--sp-4) + 16px + var(--sp-3))" : "var(--sp-5)";
  const paddingRight = trailingSlot ? "2.5rem" : "var(--sp-5)";

  return (
    <div className="relative">
      {leadingIcon && (
        <span
          className="absolute inset-y-0 left-0 flex items-center text-fg-subtle pointer-events-none"
          style={{ paddingLeft: "var(--sp-4)" }}
        >
          {leadingIcon}
        </span>
      )}
      <input
        {...inputProps}
        className={`w-full rounded-md border border-[color:var(--border)] bg-raised text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ""}`}
        style={{
          height: "42px",
          paddingLeft,
          paddingRight,
          fontSize: "var(--text-body-lg)",
          lineHeight: "var(--lh-body-lg)",
          ...style,
        }}
      />
      {trailingSlot && (
        <div className="absolute inset-y-0 right-0 flex items-center pr-sp-4">
          {trailingSlot}
        </div>
      )}
    </div>
  );
}

export interface OidcProviderItem {
  id: string;
  name: string;
}

export type SsoSectionProps = {
  providers: OidcProviderItem[];
  mode: "login" | "register";
  t: (key: string, params?: Record<string, string>) => string;
  /** Base URL for OIDC authorize links (e.g. API origin) */
  apiBaseUrl?: string;
};

export function SsoSection({ providers, mode, t, apiBaseUrl = "" }: SsoSectionProps) {
  if (providers.length === 0) return null;

  const labelKey = mode === "login" ? "auth.sso.sign_in_with" : "auth.sso.sign_up_with";

  return (
    <>
      <div className="flex items-center" style={{ gap: "var(--sp-5)", margin: "var(--sp-2) 0" }}>
        <span className="flex-1 h-px bg-[color:var(--border-subtle)]" aria-hidden="true" />
        <span className="text-fg-subtle lowercase" style={{ fontSize: "var(--text-small)" }}>
          {t("auth.sso.divider")}
        </span>
        <span className="flex-1 h-px bg-[color:var(--border-subtle)]" aria-hidden="true" />
      </div>

      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {providers.map((p) => (
          <a
            key={p.id}
            href={`${apiBaseUrl}/auth/oidc/${p.id}/authorize`}
            className="flex items-center justify-center border border-[color:var(--border)] bg-raised text-fg font-medium transition-colors hover:bg-raised-2 hover:border-[color:var(--border-strong)]"
            style={{
              height: "44px",
              borderRadius: "var(--r-md)",
              gap: "var(--sp-4)",
              fontSize: "var(--text-body-lg)",
              lineHeight: 1,
            }}
          >
            <ExternalProviderIcon />
            {t(labelKey, { provider: p.name })}
          </a>
        ))}
      </div>
    </>
  );
}

function ExternalProviderIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

export function MailFieldIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

export function LockFieldIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function UserFieldIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  );
}

export function KeyFieldIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}

export function AuthButton({
  children,
  isSubmitting,
  disabled,
  className,
  style,
}: {
  children: React.ReactNode;
  isSubmitting?: boolean;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="submit"
      disabled={isSubmitting || disabled}
      className={`w-full rounded-md bg-accent font-medium text-accent-fg transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ""}`}
      style={{ height: "44px", fontSize: "var(--text-body-lg)", lineHeight: 1, ...style }}
    >
      {children}
    </button>
  );
}

export function AuthHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div style={{ marginBottom: "var(--sp-8)" }}>
      <h2
        className="text-fg"
        style={{
          margin: subtitle ? "0 0 var(--sp-4)" : 0,
          fontWeight: "var(--weight-semi)",
          fontSize: "var(--text-h1)",
          lineHeight: "var(--lh-h1)",
          letterSpacing: "var(--track-tight)",
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <p
          className="text-fg-muted"
          style={{ margin: 0, fontSize: "var(--text-body-lg)", lineHeight: "var(--lh-body-lg)" }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start rounded-md border border-[color:var(--danger-subtle)] bg-[color:var(--danger-subtle)] px-sp-4 py-sp-3"
      style={{ gap: "var(--sp-3)" }}
    >
      <p
        className="text-danger-text"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {message}
      </p>
    </div>
  );
}

export function SuccessBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex items-start rounded-md border border-[color:var(--success-subtle)] bg-[color:var(--success-subtle)] px-sp-4 py-sp-3"
      style={{ gap: "var(--sp-3)" }}
    >
      <p
        className="text-success-text"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {message}
      </p>
    </div>
  );
}

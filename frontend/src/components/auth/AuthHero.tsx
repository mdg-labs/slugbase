import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Github } from 'lucide-react';
import { isCloud } from '@/config/mode';
import api from '@/api/client';
import { cn } from '@/lib/utils';

/**
 * Right column for Login / Signup — copy entirely from i18n (`auth.hero.*` §10.1).
 */
export function AuthHero() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    api
      .get('/version')
      .then((res) => {
        const ver = (res.data?.version as string | undefined)?.trim();
        const commit = (res.data?.commit as string | undefined)?.trim();
        const raw = ver || commit || '';
        if (raw) setVersion(raw);
      })
      .catch(() => setVersion(null));
  }, []);

  const chip = isCloud ? t('auth.hero.cloud.chip') : t('auth.hero.selfhosted.chip');
  const title = t('auth.hero.title');
  const accentPhrase = t('auth.hero.titleAccent');
  const accentIdx = title.indexOf(accentPhrase);
  const titleHead = accentIdx >= 0 ? title.slice(0, accentIdx).trimEnd() : title;
  const showAccent = accentIdx >= 0;

  const desc = isCloud ? t('auth.hero.desc.cloud') : t('auth.hero.desc.selfhosted');
  const previewUrl = isCloud ? t('auth.hero.previewUrl.cloud') : t('auth.hero.previewUrl.selfhosted');

  const stat1 = isCloud
    ? { a: t('auth.hero.cloud.stat1Title'), b: t('auth.hero.cloud.stat1Subtitle') }
    : { a: t('auth.hero.selfhosted.stat1Title'), b: t('auth.hero.selfhosted.stat1Subtitle') };
  const stat2 = isCloud
    ? { a: t('auth.hero.cloud.stat2Title'), b: t('auth.hero.cloud.stat2Subtitle') }
    : { a: t('auth.hero.selfhosted.stat2Title'), b: t('auth.hero.selfhosted.stat2Subtitle') };

  const formatVersionForStat = (raw: string) => {
    if (/^[0-9]+\.[0-9]/.test(raw)) return raw.startsWith('v') ? raw : `v${raw}`;
    if (/^[a-f0-9]{7,40}$/i.test(raw)) return raw.slice(0, 7);
    return raw;
  };

  const stat3SelfHosted = () => {
    if (isCloud) {
      return {
        a: t('auth.hero.cloud.stat3Title'),
        b: t('auth.hero.cloud.stat3Subtitle'),
      };
    }
    if (version) {
      const display = formatVersionForStat(version);
      return {
        a: t('auth.hero.selfhosted.stat3Title', { version: display }),
        b: t('auth.hero.selfhosted.stat3Subtitle'),
      };
    }
    return {
      a: t('auth.hero.selfhosted.stat3FallbackTitle'),
      b: t('auth.hero.selfhosted.stat3FallbackSubtitle'),
    };
  };
  const stat3 = stat3SelfHosted();

  const footText = isCloud ? t('auth.hero.cloud.foot') : t('auth.hero.selfhosted.foot');
  const footLabel = isCloud ? t('auth.hero.cloud.footLinkLabel') : t('auth.hero.selfhosted.footLinkLabel');
  const footHref = isCloud ? t('auth.hero.cloud.footLinkHref') : t('auth.hero.selfhosted.footLinkHref');

  return (
    <div
      className={cn(
        'relative hidden min-h-screen flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--bg-1)] min-[901px]:flex',
        'bg-[radial-gradient(ellipse_at_30%_20%,var(--accent-bg)_0%,transparent_55%),radial-gradient(ellipse_at_70%_80%,rgba(217,140,244,0.08)_0%,transparent_50%)]'
      )}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(var(--border-soft) 1px, transparent 1px), linear-gradient(90deg, var(--border-soft) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
          maskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
        }}
      />
      <div className="relative z-[1] flex flex-1 flex-col justify-center px-10 py-12">
        <div className="mb-5 inline-flex w-fit rounded-full border border-[var(--accent-ring)] bg-[var(--accent-bg)] px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--accent-hi)]">
          {chip}
        </div>
        <h2 className="max-w-xl text-[34px] font-semibold leading-tight tracking-[-0.025em] text-[var(--fg-0)]">
          {titleHead}
          {showAccent ? (
            <>
              {titleHead ? ' ' : ''}
              <span className="text-[var(--accent-hi)]">{accentPhrase}</span>
            </>
          ) : null}
        </h2>
        <p className="mt-4 max-w-[420px] text-[14.5px] leading-relaxed text-[var(--fg-1)]">{desc}</p>

        <div className="mt-8 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-0)] shadow-[var(--shadow)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-2)] px-3 py-2">
            <div className="flex gap-1">
              <span className="size-2.5 rounded-full bg-[var(--danger)]/80" />
              <span className="size-2.5 rounded-full bg-[var(--warn)]/80" />
              <span className="size-2.5 rounded-full bg-[var(--success)]/80" />
            </div>
            <div className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-2 py-1 font-mono text-[11px] text-[var(--fg-3)]">
              {previewUrl}
            </div>
          </div>
          <div className="bg-[var(--bg-0)] p-4 font-mono text-[11px] leading-relaxed text-[var(--fg-2)]">
            <div className="text-[var(--fg-3)]">{'> curl -I …/go/raft'}</div>
            <div className="text-[var(--success)]">HTTP/1.1 302 Found</div>
            <div>
              <span className="text-[var(--fg-3)]">location: </span>
              <span className="text-[var(--accent-hi)]">https://…</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[var(--fg-3)]">
              <span className="rounded border border-[var(--border)] bg-[var(--bg-2)] px-1.5 py-0.5">docs</span>
              <span className="rounded border border-[var(--border)] bg-[var(--bg-2)] px-1.5 py-0.5">team</span>
              <span className="rounded border border-[var(--border)] bg-[var(--bg-2)] px-1.5 py-0.5">142 hits</span>
            </div>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-3 gap-3">
          {[stat1, stat2, stat3].map((s) => (
            <div
              key={s.a}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-3 text-center"
            >
              <div className="font-mono text-[13px] font-semibold text-[var(--fg-0)]">{s.a}</div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.04em] text-[var(--fg-3)]">{s.b}</div>
            </div>
          ))}
        </div>

        <div className="mt-auto flex items-center gap-2 pt-10 text-[12.5px] text-[var(--fg-2)]">
          {!isCloud && <Github className="size-4 shrink-0 text-[var(--fg-3)]" aria-hidden />}
          <p className="min-w-0 flex-1 leading-snug">
            {footText}{' '}
            <a
              href={footHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-[var(--accent-hi)] hover:underline"
            >
              {footLabel}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

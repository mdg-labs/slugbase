/**
 * Featurebase Messenger (Chat) widget. Cloud mode only.
 * Uses the official stub+queue loader so the SDK processes boot correctly.
 * When user is logged in, fetches a secure JWT from the backend (secure installation:
 * https://help.featurebase.app/en/help/articles/5402549-secure-your-installation-required-by-default).
 */
import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isCloud } from '../config/mode';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';

const FEATUREBASE_SDK_URL = 'https://do.featurebase.app/js/sdk.js';
const FEATUREBASE_SCRIPT_ID = 'featurebase-sdk';

declare global {
  interface Window {
    Featurebase?: (cmd: string, opts: Record<string, unknown>) => void;
  }
}

/** Ensure the official stub exists so Featurebase("boot", ...) is queued until SDK loads. */
function ensureFeaturebaseStub(): void {
  if (typeof window.Featurebase === 'function') return;
  const q: unknown[] = [];
  window.Featurebase = function (...args: unknown[]) {
    q.push(args);
  };
  (window.Featurebase as { q?: unknown[] }).q = q;
}

/** Inject the SDK script (same as official snippet: insert before first script). */
function loadFeaturebaseScript(): void {
  if (document.getElementById(FEATUREBASE_SCRIPT_ID)) return;
  const script = document.createElement('script');
  script.id = FEATUREBASE_SCRIPT_ID;
  script.src = FEATUREBASE_SDK_URL;
  script.async = true;
  const first = document.getElementsByTagName('script')[0];
  if (first?.parentNode) {
    first.parentNode.insertBefore(script, first);
  } else {
    document.head.appendChild(script);
  }
}

function getTheme(): 'light' | 'dark' {
  const root = document.documentElement;
  if (root.classList.contains('dark')) return 'dark';
  return 'light';
}

function getLanguage(userLang: string | undefined, i18nLang: string): string {
  const lang = userLang || i18nLang || 'en';
  return lang.split('-')[0] || 'en';
}

export default function FeaturebaseWidget() {
  const { user, loading } = useAuth();
  const { i18n } = useTranslation();
  const appId = (import.meta.env.VITE_FEATUREBASE_APP_ID as string)?.trim();
  const sdkInitializedRef = useRef(false);

  const runBoot = useCallback((opts: Record<string, unknown>) => {
    ensureFeaturebaseStub();
    window.Featurebase!('boot', opts);
  }, []);

  // Load SDK once when we have appId: stub first, then script (per official installation)
  useEffect(() => {
    if (!isCloud || !appId) return;
    ensureFeaturebaseStub();
    if (!sdkInitializedRef.current) {
      loadFeaturebaseScript();
      sdkInitializedRef.current = true;
    }
  }, [appId]);

  // Boot (or re-boot) when loading finishes and when user/theme/language changes
  useEffect(() => {
    if (!isCloud || !appId) return;
    const theme = getTheme();
    const language = getLanguage(user?.language, i18n.language);

    const bootAnonymous = () => {
      runBoot({
        appId,
        theme,
        language,
      });
    };

    if (loading) {
      // Wait for auth to settle before first boot
      return;
    }

    if (user) {
      api
        .get<{ token: string }>('/auth/featurebase-jwt')
        .then((res) => {
          runBoot({
            appId,
            featurebaseJwt: res.data.token,
            theme,
            language,
          });
        })
        .catch(() => {
          // Backend may return 404 if FEATUREBASE_JWT_SECRET is unset; boot anonymous
          bootAnonymous();
        });
    } else {
      bootAnonymous();
    }
  }, [isCloud, appId, loading, user?.id, user?.language, user?.theme, i18n.language, runBoot]);

  return null;
}

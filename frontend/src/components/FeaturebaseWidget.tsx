/**
 * Featurebase Messenger (Chat) widget. Cloud mode only.
 * Loads the SDK and boots with appId; when user is logged in, fetches a secure JWT
 * from the backend and passes it so Featurebase can identify the user.
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
  const scriptLoadedRef = useRef(false);
  const bootQueuedRef = useRef<Record<string, unknown> | null>(null);

  const runBoot = useCallback(
    (opts: Record<string, unknown>) => {
      if (typeof window.Featurebase !== 'function') {
        bootQueuedRef.current = opts;
        return;
      }
      window.Featurebase('boot', opts);
      bootQueuedRef.current = null;
    },
    []
  );

  // Load SDK script once when component mounts and we have appId
  useEffect(() => {
    if (!isCloud || !appId) return;
    if (document.getElementById(FEATUREBASE_SCRIPT_ID)) {
      scriptLoadedRef.current = true;
      if (bootQueuedRef.current) {
        runBoot(bootQueuedRef.current);
      }
      return;
    }
    const script = document.createElement('script');
    script.id = FEATUREBASE_SCRIPT_ID;
    script.src = FEATUREBASE_SDK_URL;
    script.async = true;
    script.onload = () => {
      scriptLoadedRef.current = true;
      if (bootQueuedRef.current) {
        runBoot(bootQueuedRef.current);
      }
    };
    document.head.appendChild(script);
  }, [appId, runBoot]);

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

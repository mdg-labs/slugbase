/**
 * SlugBase docs: vanilla-cookieconsent (orestbida) + Documentation.AI consent bridge.
 * Build the file Documentation.AI loads: `cat scripts/vendor/cookieconsent.umd.js scripts/cookie-consent-init.js > scripts/cookie-consent.bundle.js`
 * (single bundle avoids async ordering where init runs before CookieConsent exists).
 */
(function () {
  var LS_KEY = 'slugbase-docs-analytics-consent';
  var LS_VAL = 'granted';
  var CSS_URL =
    'https://cdn.jsdelivr.net/npm/vanilla-cookieconsent@3.1.0/dist/cookieconsent.css';

  function injectStylesheet() {
    if (document.querySelector('link[data-slugbase-cc="1"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    link.setAttribute('data-slugbase-cc', '1');
    document.head.appendChild(link);
  }

  function syncDocAiConsent() {
    try {
      if (typeof CookieConsent === 'undefined') return;
      if (CookieConsent.acceptedCategory('analytics')) {
        localStorage.setItem(LS_KEY, LS_VAL);
      } else {
        localStorage.removeItem(LS_KEY);
      }
    } catch (e) {
      /* ignore storage errors */
    }
  }

  injectStylesheet();

  if (typeof CookieConsent === 'undefined') {
    return;
  }

  CookieConsent.run({
    mode: 'opt-in',
    hideFromBots: false,
    cookie: {
      name: 'cc_slugbase_docs',
      expiresAfterDays: 182,
      path: '/',
      sameSite: 'Lax',
      secure: typeof location !== 'undefined' && location.protocol === 'https:'
    },
    guiOptions: {
      consentModal: {
        layout: 'box inline',
        position: 'bottom right',
        equalWeightButtons: true
      },
      preferencesModal: {
        layout: 'box',
        position: 'right',
        equalWeightButtons: true
      }
    },
    categories: {
      necessary: {
        readOnly: true,
        enabled: true
      },
      analytics: {
        enabled: false,
        autoClear: {
          cookies: [{ name: /^(_ga|_gid)/ }]
        }
      }
    },
    language: {
      default: 'en',
      translations: {
        en: {
          consentModal: {
            title: 'Cookie preferences',
            description:
              'We use optional, privacy-friendly analytics on this documentation site. You can accept or reject analytics cookies; necessary cookies are always on.',
            acceptAllBtn: 'Accept all',
            acceptNecessaryBtn: 'Reject optional',
            showPreferencesBtn: 'Customize',
            footer:
              '<a href="/cloud/privacy-and-cookies">Privacy and cookies (Cloud)</a>'
          },
          preferencesModal: {
            title: 'Cookie preferences',
            acceptAllBtn: 'Accept all',
            acceptNecessaryBtn: 'Reject optional',
            savePreferencesBtn: 'Save preferences',
            closeIconLabel: 'Close',
            sections: [
              {
                title: 'Overview',
                description:
                  'Optional analytics help us understand which documentation pages are useful. See Privacy and cookies for details.'
              },
              {
                title: 'Strictly necessary',
                description:
                  'Needed for the site to function and to remember your consent.',
                linkedCategory: 'necessary'
              },
              {
                title: 'Analytics',
                description:
                  'Loads privacy-friendly analytics when enabled. If you reject this category, the analytics script is not loaded.',
                linkedCategory: 'analytics'
              }
            ]
          }
        }
      }
    },
    onFirstConsent: function () {
      syncDocAiConsent();
    },
    onConsent: function () {
      syncDocAiConsent();
    },
    onChange: function () {
      syncDocAiConsent();
    }
  });
})();

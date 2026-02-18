import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import api from '../../api/client';
import MarketingLayout from '../../components/MarketingLayout';

const GITHUB_URL = 'https://github.com/mdg-labs/slugbase';
const DOCS_URL = 'https://docs.slugbase.app';

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export default function Contact() {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const isFormValid =
    name.trim().length > 0 &&
    isValidEmail(email) &&
    message.trim().length > 0;
  const isSubmitDisabled = loading || !isFormValid;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/contact', { name, email, message });
      setSent(true);
      setName('');
      setEmail('');
      setMessage('');
    } catch (err: unknown) {
      const errObj = err as { response?: { data?: { error?: string } } };
      setError(errObj.response?.data?.error || t('contact.error'));
    } finally {
      setLoading(false);
    }
  };

  const inputClasses =
    'mt-1 block w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

  return (
    <MarketingLayout>
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('contact.title')}</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">{t('contact.subtitle')}</p>
        </div>

        <p className="mb-8 text-center text-sm text-gray-600 dark:text-gray-400">
          {t('contact.trustParagraph')}
        </p>

        <div className="mb-8 flex flex-wrap items-center justify-center gap-4 text-sm">
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
          >
            {t('contact.linksDocs')}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
          >
            {t('contact.linksGitHub')}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
          <Link
            to="/pricing"
            className="inline-flex items-center text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
          >
            {t('contact.linksPricing')}
          </Link>
          <Link
            to="/app/signup"
            className="inline-flex items-center text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
          >
            {t('contact.linksDemo')}
          </Link>
        </div>

        {sent ? (
          <div
            className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-6 text-center text-green-800 dark:text-green-200"
            role="status"
            aria-live="polite"
          >
            {t('contact.success')}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
            {error && (
              <div
                className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300"
                role="alert"
              >
                {error}
              </div>
            )}
            <div>
              <label htmlFor="contact-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('contact.name')}
              </label>
              <input
                id="contact-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClasses}
                autoComplete="name"
              />
            </div>
            <div>
              <label htmlFor="contact-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('contact.email')}
              </label>
              <input
                id="contact-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClasses}
                autoComplete="email"
              />
            </div>
            <div>
              <label htmlFor="contact-message" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('contact.message')}
              </label>
              <textarea
                id="contact-message"
                rows={4}
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className={inputClasses}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {t('contact.privacyNotice')}{' '}
              <Link to="/privacy" className="text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded">
                {t('legal.privacyTitle')}
              </Link>
            </p>
            <button
              type="submit"
              disabled={isSubmitDisabled}
              className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? t('common.loading') : t('contact.send')}
            </button>
          </form>
        )}
      </div>
    </MarketingLayout>
  );
}

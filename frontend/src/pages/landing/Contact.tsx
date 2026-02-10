import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { isCloud } from '../../config/mode';
import MarketingLayout from '../../components/MarketingLayout';

export default function Contact() {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!isCloud) {
      window.location.href = `mailto:?subject=SlugBase%20contact&body=${encodeURIComponent(`Name: ${name}\nEmail: ${email}\n\n${message}`)}`;
      return;
    }
    setLoading(true);
    try {
      await api.post('/contact', { name, email, message });
      setSent(true);
      setName('');
      setEmail('');
      setMessage('');
    } catch (err: any) {
      setError(err.response?.data?.error || t('contact.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <MarketingLayout>
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('contact.title')}</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">{t('contact.subtitle')}</p>
        </div>

        {sent ? (
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 text-center text-green-800 dark:text-green-200">
            {t('contact.success')}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
            {error && (
              <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
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
                className="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
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
                className="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
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
                className="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {loading ? t('common.loading') : t('contact.send')}
            </button>
          </form>
        )}
      </div>
    </MarketingLayout>
  );
}

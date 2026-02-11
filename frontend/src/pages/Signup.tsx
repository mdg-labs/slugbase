import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import Button from '../components/ui/Button';

export default function Signup() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError(t('setup.passwordMismatch'));
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/register', { email, name, password });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg p-6 text-center space-y-4">
          <div className="flex justify-center mb-4">
            <img src="/slugbase_icon_blue.svg" alt="SlugBase" className="h-16 w-16 dark:hidden" />
            <img src="/slugbase_icon_white.svg" alt="SlugBase" className="h-16 w-16 hidden dark:block" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            {t('signup.successTitle')}
          </h2>
          <p className="text-gray-600 dark:text-gray-400 text-sm">
            {t('signup.successMessage')}
          </p>
          <Link
            to="/app/login"
            className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
          >
            {t('signup.backToLogin')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <img src="/slugbase_icon_blue.svg" alt="SlugBase" className="h-16 w-16 dark:hidden" />
            <img src="/slugbase_icon_white.svg" alt="SlugBase" className="h-16 w-16 hidden dark:block" />
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
            {t('signup.title')}
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {t('signup.subtitle')}
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg p-4">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="signup-email" className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                {t('signup.email')}
              </label>
              <input
                id="signup-email"
                type="email"
                required
                autoComplete="email"
                className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={t('auth.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="signup-name" className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                {t('signup.name')}
              </label>
              <input
                id="signup-name"
                type="text"
                required
                autoComplete="name"
                className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={t('signup.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="signup-password" className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                {t('signup.password')}
              </label>
              <input
                id="signup-password"
                type="password"
                required
                autoComplete="new-password"
                className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={t('setup.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="signup-confirm" className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                {t('signup.confirmPassword')}
              </label>
              <input
                id="signup-confirm"
                type="password"
                required
                autoComplete="new-password"
                className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={t('setup.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            {error && (
              <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={loading}
              className="w-full"
            >
              {loading ? t('common.loading') : t('signup.submit')}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
            {t('signup.alreadyHaveAccount')}{' '}
            <Link to="/app/login" className="font-medium text-blue-600 dark:text-blue-400 hover:underline">
              {t('signup.logIn')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

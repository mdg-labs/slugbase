import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';
import { isCloud } from '../config/mode';
import { CheckCircle, XCircle, Mail } from 'lucide-react';
import Button from '../components/ui/Button';

export default function AcceptInvite() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, checkAuth } = useAuth();
  const [status, setStatus] = useState<'verifying' | 'accepting' | 'success' | 'error' | 'login_required'>('verifying');
  const [error, setError] = useState('');
  const [orgName, setOrgName] = useState('');

  const token = searchParams.get('token');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setError(t('invitations.tokenRequired'));
      return;
    }
    if (!isCloud) {
      setStatus('error');
      setError(t('invitations.notAvailable'));
      return;
    }
    api
      .get('/invitations/verify', { params: { token } })
      .then((res) => {
        if (res.data.valid) {
          setOrgName(res.data.org_name || '');
          if (user) {
            setStatus('accepting');
            api
              .post('/invitations/accept', { token })
              .then(() => {
                setStatus('success');
                checkAuth();
                setTimeout(() => navigate('/app'), 2000);
              })
              .catch((err: any) => {
                setStatus('error');
                setError(err.response?.data?.error || t('common.error'));
              });
          } else {
            setStatus('login_required');
          }
        } else {
          setStatus('error');
          setError(res.data.error || t('invitations.invalidOrExpired'));
        }
      })
      .catch(() => {
        setStatus('error');
        setError(t('invitations.invalidOrExpired'));
      });
  }, [token, user, t, navigate, checkAuth]);

  if (status === 'verifying' || status === 'accepting') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg p-4 text-center">
          <div className="mx-auto w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center mb-4">
            <Mail className="h-8 w-8 text-blue-600 dark:text-blue-400 animate-pulse" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            {status === 'verifying' ? t('invitations.verifying') : t('invitations.accepting')}
          </h2>
        </div>
      </div>
    );
  }

  if (status === 'login_required') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg p-6 text-center">
          <div className="mx-auto w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mb-4">
            <Mail className="h-8 w-8 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
            {t('invitations.loginRequired')}
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {t('invitations.loginRequiredDescription', { org: orgName })}
          </p>
          <Link to={`/app/login?redirect=${encodeURIComponent(`/app/accept-invite${token ? `?token=${token}` : ''}`)}`}>
            <Button variant="primary">{t('auth.login')}</Button>
          </Link>
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            <Link to="/app/signup" className="text-blue-600 dark:text-blue-400 hover:underline">
              {t('auth.signUp')}
            </Link>
          </p>
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg p-6 text-center">
          <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
            <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
            {t('invitations.accepted')}
          </h2>
          <p className="text-gray-600 dark:text-gray-400">{t('invitations.redirecting')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg p-6 text-center">
        <div className="mx-auto w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mb-4">
          <XCircle className="h-8 w-8 text-red-600 dark:text-red-400" />
        </div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
          {t('invitations.error')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-4">{error}</p>
        <Link to="/app/login">
          <Button variant="primary">{t('auth.login')}</Button>
        </Link>
      </div>
    </div>
  );
}

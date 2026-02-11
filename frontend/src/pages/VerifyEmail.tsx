import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';
import { isCloud } from '../config/mode';
import { CheckCircle, XCircle, Mail } from 'lucide-react';
import Button from '../components/ui/Button';

export default function VerifyEmail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { checkAuth } = useAuth();
  const profilePath = isCloud ? '/app/profile' : '/profile';
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
  const [error, setError] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [signupVerified, setSignupVerified] = useState(false);

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      setError(t('emailVerification.tokenRequired'));
      return;
    }

    // Try signup verification first (CLOUD registration)
    api.post('/auth/verify-signup', { token })
      .then(() => {
        setStatus('success');
        setSignupVerified(true);
        setTimeout(() => {
          navigate('/app/login');
        }, 2500);
      })
      .catch(() => {
        // Not a signup token; try profile email-change verification
        api.get('/email-verification/verify', { params: { token } })
          .then(async (response) => {
            if (response.data.valid) {
              setNewEmail(response.data.newEmail || '');
              try {
                await api.post('/email-verification/confirm', { token });
                setStatus('success');
                await checkAuth();
                setTimeout(() => {
                  navigate(profilePath);
                }, 3000);
              } catch (err: any) {
                setStatus('error');
                setError(err.response?.data?.error || t('emailVerification.confirmFailed'));
              }
            } else {
              setStatus('error');
              setError(response.data.error || t('emailVerification.invalidToken'));
            }
          })
          .catch((err: any) => {
            setStatus('error');
            setError(err.response?.data?.error || t('emailVerification.verifyFailed'));
          });
      });
  }, [searchParams, t, navigate, checkAuth]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg p-4">
        <div className="text-center space-y-4">
          {status === 'verifying' && (
            <>
              <div className="mx-auto w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
                <Mail className="h-8 w-8 text-blue-600 dark:text-blue-400 animate-pulse" />
              </div>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
                {t('emailVerification.verifying')}
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                {t('emailVerification.verifyingDescription')}
              </p>
            </>
          )}

          {status === 'success' && (
            <>
              <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
                <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
                {signupVerified ? t('emailVerification.signupSuccess') : t('emailVerification.success')}
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                {signupVerified ? t('emailVerification.signupSuccessDescription') : t('emailVerification.successDescription', { email: newEmail })}
              </p>
              {!signupVerified && (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('emailVerification.redirecting')}
                </p>
              )}
            </>
          )}

          {status === 'error' && (
            <>
              <div className="mx-auto w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
                <XCircle className="h-8 w-8 text-red-600 dark:text-red-400" />
              </div>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
                {t('emailVerification.error')}
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                {error || t('emailVerification.errorDescription')}
              </p>
              <div className="pt-4">
                <Button
                  variant="primary"
                  onClick={() => navigate(profilePath)}
                >
                  {t('emailVerification.backToProfile')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

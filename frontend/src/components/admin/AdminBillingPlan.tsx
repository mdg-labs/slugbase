import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { UserPlus } from 'lucide-react';
import Button from '../ui/Button';

interface Org {
  id: string;
  name: string;
  plan: string;
  included_seats: number;
  member_count: number;
  role: string;
  members: Array<{ id: string; email: string; name: string; role: string }>;
}

interface Plan {
  id: string;
  name: string;
  price_monthly?: number;
  price_yearly?: number;
  price_one_time?: number;
  included_seats: number;
}

export default function AdminBillingPlan() {
  const { t } = useTranslation();
  const [org, setOrg] = useState<Org | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [orgRes, plansRes] = await Promise.all([
        api.get('/organizations/me'),
        api.get('/billing/plans'),
      ]);
      setOrg(orgRes.data);
      setPlans(plansRes.data?.plans || []);
    } catch (error: any) {
      if (error.response?.status === 404) {
        setOrg(null);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCheckout = async (plan: string, interval: string) => {
    setCheckoutLoading(`${plan}-${interval}`);
    try {
      const frontendUrl = window.location.origin;
      const res = await api.post('/billing/create-checkout-session', {
        plan,
        interval,
        success_url: `${frontendUrl}/app/admin?tab=billing`,
        cancel_url: `${frontendUrl}/app/admin?tab=billing`,
      });
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch (error: any) {
      console.error('Checkout error:', error);
      alert(error.response?.data?.error || t('common.error'));
      setCheckoutLoading(null);
    }
  };

  const handlePortal = async () => {
    setCheckoutLoading('portal');
    try {
      const frontendUrl = window.location.origin;
      const res = await api.post('/billing/create-portal-session', {
        return_url: `${frontendUrl}/app/admin?tab=billing`,
      });
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch (error: any) {
      console.error('Portal error:', error);
      alert(error.response?.data?.error || t('common.error'));
      setCheckoutLoading(null);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org || !inviteEmail.trim()) return;
    setInviteLoading(true);
    setInviteError('');
    try {
      await api.post(`/organizations/${org.id}/invite`, { email: inviteEmail.trim() });
      setInviteEmail('');
      loadData();
    } catch (error: any) {
      setInviteError(error.response?.data?.error || t('common.error'));
    } finally {
      setInviteLoading(false);
    }
  };

  const planName = (id: string) => {
    const names: Record<string, string> = {
      free: t('pricing.free'),
      personal: t('pricing.personal'),
      team: t('pricing.team'),
      early_supporter: t('pricing.earlySupporter'),
    };
    return names[id] || id;
  };

  if (loading) {
    return (
      <div className="text-center py-8 text-gray-500 dark:text-gray-400">
        {t('common.loading')}
      </div>
    );
  }

  if (!org) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <p className="text-gray-600 dark:text-gray-400">{t('common.error')}</p>
      </div>
    );
  }

  const canManageBilling = org.role === 'owner' || org.role === 'admin';
  const paidPlans = plans.filter((p) => p.id !== 'free');
  const orgWithStripe = org as Org & { stripe_customer_id?: string };

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {t('admin.billingCurrentPlan')}
        </h2>
        <p className="text-2xl font-bold text-gray-900 dark:text-white">
          {planName(org.plan)}
        </p>
        {orgWithStripe.stripe_customer_id && canManageBilling && (
          <Button
            variant="secondary"
            onClick={handlePortal}
            disabled={!!checkoutLoading}
            className="mt-4"
          >
            {checkoutLoading === 'portal' ? t('common.loading') : t('admin.billingManageSubscription')}
          </Button>
        )}
      </div>

      {canManageBilling && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            {t('admin.billingUpgrade')}
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {paidPlans.map((plan) => (
              <div key={plan.id} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <p className="font-medium text-gray-900 dark:text-white">{planName(plan.id)}</p>
                {plan.price_one_time && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    €{(plan.price_one_time / 100).toFixed(0)} one-time
                  </p>
                )}
                {plan.price_monthly !== undefined && plan.price_monthly > 0 && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    €{(plan.price_monthly / 100).toFixed(0)}/mo · €{((plan.price_yearly || 0) / 100).toFixed(0)}/yr
                  </p>
                )}
                <div className="mt-3 flex gap-2 flex-wrap">
                  {plan.id === 'early_supporter' && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!!checkoutLoading || org.plan === plan.id}
                      onClick={() => handleCheckout(plan.id, 'one_time')}
                    >
                      {checkoutLoading ? t('common.loading') : t('admin.billingEarlySupporter')}
                    </Button>
                  )}
                  {plan.id === 'personal' && (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!!checkoutLoading || org.plan === plan.id}
                        onClick={() => handleCheckout(plan.id, 'monthly')}
                      >
                        {checkoutLoading === 'personal-monthly' ? t('common.loading') : t('admin.billingPersonalMonthly')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!!checkoutLoading || org.plan === plan.id}
                        onClick={() => handleCheckout(plan.id, 'yearly')}
                      >
                        {checkoutLoading === 'personal-yearly' ? t('common.loading') : t('admin.billingPersonalYearly')}
                      </Button>
                    </>
                  )}
                  {plan.id === 'team' && (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!!checkoutLoading || org.plan === plan.id}
                        onClick={() => handleCheckout(plan.id, 'monthly')}
                      >
                        {checkoutLoading === 'team-monthly' ? t('common.loading') : t('admin.billingTeamMonthly')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!!checkoutLoading || org.plan === plan.id}
                        onClick={() => handleCheckout(plan.id, 'yearly')}
                      >
                        {checkoutLoading === 'team-yearly' ? t('common.loading') : t('admin.billingTeamYearly')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          {paidPlans.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('admin.billingNotConfigured')}</p>
          )}
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {t('admin.billingOrgMembers')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('admin.billingSeatsUsed', {
            count: org.member_count,
            total: org.included_seats,
          })}
        </p>
        <ul className="space-y-2 mb-4">
          {org.members?.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700 last:border-0"
            >
              <div>
                <span className="font-medium text-gray-900 dark:text-white">{m.name || m.email}</span>
                <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">({m.email})</span>
              </div>
              <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                {m.role}
              </span>
            </li>
          ))}
        </ul>
        {canManageBilling && (
          <form onSubmit={handleInvite} className="flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              className="flex-1 px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
              required
            />
            <Button
              type="submit"
              variant="primary"
              disabled={inviteLoading}
              icon={UserPlus}
            >
              {inviteLoading ? t('common.loading') : t('admin.billingInviteMember')}
            </Button>
          </form>
        )}
        {inviteError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{inviteError}</p>
        )}
      </div>
    </div>
  );
}

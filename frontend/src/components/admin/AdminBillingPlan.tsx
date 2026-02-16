import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { UserPlus, Sparkles } from 'lucide-react';
import Button from '../ui/Button';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Progress } from '../ui/progress';
import { useOrgPlan } from '../../contexts/OrgPlanContext';
import { appBasePath } from '../../config/api';

interface Org {
  id: string;
  name: string;
  plan: string;
  included_seats: number;
  member_count: number;
  role: string;
  ai_enabled?: boolean;
  members: Array<{ id: string; email: string; name: string; role: string }>;
}

interface Plan {
  id: string;
  name: string;
  price_monthly?: number;
  price_yearly?: number;
  price_one_time?: number;
  included_seats: number;
  extra_seat_monthly?: number | null;
  extra_seat_yearly?: number | null;
}

interface Invoice {
  id: string;
  number: string;
  status: string;
  amount_paid: number;
  currency: string;
  created: number;
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
}

export default function AdminBillingPlan() {
  const { t } = useTranslation();
  const { bookmarkCount, bookmarkLimit } = useOrgPlan();
  const [org, setOrg] = useState<Org | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [aiSaving, setAiSaving] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesError, setInvoicesError] = useState('');

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
      const orgData = orgRes.data;
      setOrg(orgData);
      setPlans(plansRes.data?.plans || []);
      const orgWithStripe = orgData as Org & { stripe_customer_id?: string };
      const canManage = orgData?.role === 'owner' || orgData?.role === 'admin';
      if (orgWithStripe?.stripe_customer_id && canManage) {
        setInvoicesLoading(true);
        setInvoicesError('');
        try {
          const invRes = await api.get('/billing/invoices');
          setInvoices(invRes.data?.invoices || []);
        } catch (err: any) {
          setInvoicesError(err.response?.data?.error || t('common.error'));
          setInvoices([]);
        } finally {
          setInvoicesLoading(false);
        }
      } else {
        setInvoices([]);
        setInvoicesError('');
      }
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
        success_url: `${frontendUrl}${appBasePath}/admin/billing`,
        cancel_url: `${frontendUrl}${appBasePath}/admin/billing`,
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
        return_url: `${frontendUrl}${appBasePath}/admin/billing`,
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

  const handleAiToggle = async (checked: boolean) => {
    if (!org) return;
    setAiSaving(true);
    try {
      await api.patch('/organizations/me/ai', { ai_enabled: checked });
      setOrg({ ...org, ai_enabled: checked });
    } catch (error: any) {
      console.error('AI toggle error:', error);
    } finally {
      setAiSaving(false);
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

  const planFeatures: Record<string, string[]> = {
    free: [t('pricing.freeValue1'), t('pricing.freeValue2'), t('pricing.freeValue3')],
    personal: [t('pricing.personalValue1'), t('pricing.personalValue2'), t('pricing.personalValue3')],
    team: [t('pricing.teamValue1'), t('pricing.teamValue2'), t('pricing.teamValue3')],
    early_supporter: [t('pricing.earlySupporterHelp'), t('pricing.earlySupporterIncludes'), t('pricing.earlySupporterSeats'), t('pricing.earlySupporterNote')],
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
  const canInviteMembers = org.plan === 'team' && org.member_count < org.included_seats;
  const paidPlans = plans.filter((p) => p.id !== 'free');
  const orgWithStripe = org as Org & { stripe_customer_id?: string };

  const isFreePlan = org.plan === 'free';
  const showBookmarkUsage = isFreePlan && bookmarkLimit != null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('admin.billingCurrentPlan')}
          </h2>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {planName(org.plan)}
          </p>
          {showBookmarkUsage && (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-muted-foreground">
                {t('plan.bookmarksUsed', { count: bookmarkCount, limit: bookmarkLimit })}
              </p>
              <Progress value={bookmarkLimit ? Math.min(100, (bookmarkCount / bookmarkLimit) * 100) : 0} className="h-2" />
            </div>
          )}
        </CardHeader>
        <CardContent>
          {orgWithStripe.stripe_customer_id && canManageBilling && (
            <Button
              variant="secondary"
              onClick={handlePortal}
              disabled={!!checkoutLoading}
            >
              {checkoutLoading === 'portal' ? t('common.loading') : t('admin.billingManageSubscription')}
            </Button>
          )}
        </CardContent>
      </Card>

      {orgWithStripe.stripe_customer_id && canManageBilling && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('admin.billingInvoices')}
            </h2>
          </CardHeader>
          <CardContent>
            {invoicesLoading ? (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : invoicesError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{invoicesError}</p>
            ) : invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('admin.billingInvoicesEmpty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="text-left py-2 font-medium text-gray-900 dark:text-white">{t('admin.billingInvoiceDate')}</th>
                      <th className="text-left py-2 font-medium text-gray-900 dark:text-white">{t('admin.billingInvoiceNumber')}</th>
                      <th className="text-left py-2 font-medium text-gray-900 dark:text-white">{t('admin.billingInvoiceAmount')}</th>
                      <th className="text-left py-2 font-medium text-gray-900 dark:text-white">{t('admin.billingInvoiceStatus')}</th>
                      <th className="text-right py-2 font-medium text-gray-900 dark:text-white">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr key={inv.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                        <td className="py-2 text-gray-600 dark:text-gray-400">
                          {new Date(inv.created * 1000).toLocaleDateString()}
                        </td>
                        <td className="py-2 font-medium text-gray-900 dark:text-white">{inv.number}</td>
                        <td className="py-2 text-gray-600 dark:text-gray-400">
                          {(inv.amount_paid / 100).toFixed(2)} {inv.currency}
                        </td>
                        <td className="py-2">
                          <Badge variant="secondary" className="text-xs">{inv.status}</Badge>
                        </td>
                        <td className="py-2 text-right">
                          <span className="flex gap-2 justify-end">
                            {inv.invoice_pdf && (
                              <a
                                href={inv.invoice_pdf}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline text-xs"
                              >
                                {t('admin.billingInvoiceDownload')}
                              </a>
                            )}
                            {inv.hosted_invoice_url && (
                              <a
                                href={inv.hosted_invoice_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline text-xs"
                              >
                                {t('admin.billingInvoiceView')}
                              </a>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canManageBilling && (org.plan === 'personal' || org.plan === 'team' || org.plan === 'early_supporter') && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-500 dark:text-violet-400" />
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('admin.ai.orgTitle')}
              </h2>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {t('admin.ai.orgDescription')}
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <Switch
                id="org-ai-enabled"
                checked={org.ai_enabled ?? false}
                onCheckedChange={handleAiToggle}
                disabled={aiSaving}
              />
              <Label htmlFor="org-ai-enabled" className="text-sm font-medium cursor-pointer">
                {t('admin.ai.orgEnabled')}
              </Label>
            </div>
          </CardContent>
        </Card>
      )}

      {canManageBilling && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('admin.billingUpgrade')}
            </h2>
          </CardHeader>
          <CardContent className="space-y-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setBillingInterval('monthly')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                billingInterval === 'monthly'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBillingInterval('yearly')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                billingInterval === 'yearly'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              Yearly
            </button>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {plans.map((plan) => {
              const isCurrent = org.plan === plan.id;
              const features = planFeatures[plan.id] || [];
              return (
                <Card
                  key={plan.id}
                  className={`flex flex-col min-h-[320px] ${
                    plan.id === 'personal'
                      ? 'border-primary/30 ring-2 ring-primary/20'
                      : ''
                  }`}
                >
                  <CardHeader className="p-4 pb-2">
                  {plan.id === 'personal' && (
                    <Badge variant="secondary" className="w-fit mb-2 text-xs bg-primary/20 text-primary">
                      {t('pricing.mostPopular')}
                    </Badge>
                  )}
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{planName(plan.id)}</h3>
                  {plan.id === 'free' && (
                    <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.freePrice')}</p>
                  )}
                  {plan.id === 'personal' && (
                    <>
                      <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">
                        {billingInterval === 'monthly' ? t('pricing.personalPrice') : `€${((plan.price_yearly || 0) / 100).toFixed(0)}/yr`}
                      </p>
                      <p className="text-sm text-muted-foreground">{t('pricing.personalYearly')}</p>
                    </>
                  )}
                  {plan.id === 'team' && (
                    <>
                      <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">
                        {billingInterval === 'monthly' ? t('pricing.teamPrice') : t('pricing.teamPriceYearly')}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('pricing.teamUsers')} · {billingInterval === 'monthly' ? t('pricing.teamExtraUser') : t('pricing.teamExtraUserYearly')}
                      </p>
                    </>
                  )}
                  {plan.id === 'early_supporter' && (
                    <>
                      <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400">{t('pricing.earlySupporterLifetime')}</p>
                      <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.earlySupporterPrice')}</p>
                    </>
                  )}
                  </CardHeader>
                  <CardContent className="p-4 pt-0 flex flex-col flex-1">
                  <ul className="space-y-2 text-sm text-muted-foreground flex-1">
                    {features.map((f, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-primary mt-0.5">•</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  {plan.id !== 'free' && (
                    <div className="mt-4 flex gap-2 flex-wrap">
                      {plan.id === 'early_supporter' && (
                        <Button
                          variant="primary"
                          size="sm"
                          className="w-full"
                          disabled={!!checkoutLoading || isCurrent}
                          onClick={() => handleCheckout(plan.id, 'one_time')}
                        >
                          {checkoutLoading === 'early_supporter-one_time' ? t('common.loading') : t('pricing.earlySupporterPrice')}
                        </Button>
                      )}
                      {plan.id === 'personal' && (
                        <>
                          <Button
                            variant="primary"
                            size="sm"
                            className="flex-1"
                            disabled={!!checkoutLoading || isCurrent}
                            onClick={() => handleCheckout(plan.id, 'monthly')}
                          >
                            {checkoutLoading === 'personal-monthly' ? t('common.loading') : t('pricing.personalPrice')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            className="flex-1"
                            disabled={!!checkoutLoading || isCurrent}
                            onClick={() => handleCheckout(plan.id, 'yearly')}
                          >
                            {checkoutLoading === 'personal-yearly' ? t('common.loading') : `€${((plan.price_yearly || 0) / 100).toFixed(0)}/yr`}
                          </Button>
                        </>
                      )}
                      {plan.id === 'team' && (
                        <>
                          <Button
                            variant="primary"
                            size="sm"
                            className="flex-1"
                            disabled={!!checkoutLoading || isCurrent}
                            onClick={() => handleCheckout(plan.id, 'monthly')}
                          >
                            {checkoutLoading === 'team-monthly' ? t('common.loading') : t('pricing.teamPrice')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            className="flex-1"
                            disabled={!!checkoutLoading || isCurrent}
                            onClick={() => handleCheckout(plan.id, 'yearly')}
                          >
                            {checkoutLoading === 'team-yearly' ? t('common.loading') : t('pricing.teamPriceYearly')}
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                  {plan.id === 'free' && isCurrent && (
                    <p className="mt-4 text-sm text-muted-foreground">{t('admin.billingCurrentPlan')}</p>
                  )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          {paidPlans.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('admin.billingNotConfigured')}</p>
          )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('admin.billingOrgMembers')}
          </h2>
        </CardHeader>
        <CardContent>
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
        {canManageBilling && canInviteMembers && (
          <form onSubmit={handleInvite} className="flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              className="flex-1 px-4 py-2 text-sm border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-ring"
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
        {canManageBilling && !canInviteMembers && org.plan !== 'team' && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
            {t('admin.billingUpgradeToInvite')}
          </p>
        )}
        {canManageBilling && !canInviteMembers && org.plan === 'team' && org.member_count >= org.included_seats && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
            {t('admin.billingTeamAtLimit')}
          </p>
        )}
        {inviteError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{inviteError}</p>
        )}
        </CardContent>
      </Card>
    </div>
  );
}

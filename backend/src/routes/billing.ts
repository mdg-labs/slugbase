import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { authRateLimiter } from '../middleware/security.js';
import { query, queryOne, execute } from '../db/index.js';
import { isCloud } from '../config/mode.js';
import { clearFreePlanGrace, getCurrentOrgId, setFreePlanGraceIfOverLimit } from '../utils/organizations.js';
import { validateRedirectUrl } from '../utils/validation.js';

const router = Router();

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key);
}

/**
 * @swagger
 * /api/billing/plans:
 *   get:
 *     summary: Get plan definitions
 *     description: Returns available subscription plans and pricing. Cloud mode only. Public.
 *     tags: [Billing]
 *     responses:
 *       200:
 *         description: Plan definitions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 plans:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       price_monthly:
 *                         type: number
 *                       price_yearly:
 *                         type: number
 *                       included_seats:
 *                         type: number
 *       404:
 *         description: Not found (self-hosted mode)
 */
router.get('/plans', (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({
    plans: [
      {
        id: 'free',
        name: 'Free',
        price_monthly: 0,
        price_yearly: 0,
        included_seats: 1,
        extra_seat_monthly: null,
        extra_seat_yearly: null,
      },
      {
        id: 'personal',
        name: 'Personal',
        price_monthly: 300, // cents
        price_yearly: 3000,
        included_seats: 1,
        extra_seat_monthly: null,
        extra_seat_yearly: null,
      },
      {
        id: 'team',
        name: 'Team',
        price_monthly: 900,
        price_yearly: 9000,
        included_seats: 5,
        extra_seat_monthly: 100,
        extra_seat_yearly: 1000,
      },
      {
        id: 'early_supporter',
        name: 'Early Supporter',
        price_one_time: 6900,
        included_seats: 1,
      },
    ],
  });
});

/**
 * @swagger
 * /api/billing/create-checkout-session:
 *   post:
 *     summary: Create Stripe Checkout session
 *     description: Creates a Stripe Checkout session for subscription. Org owner/admin only. Cloud mode only.
 *     tags: [Billing]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - plan
 *               - interval
 *               - success_url
 *               - cancel_url
 *             properties:
 *               plan:
 *                 type: string
 *                 enum: [free, personal, team, early_supporter]
 *               interval:
 *                 type: string
 *                 enum: [monthly, yearly, one_time]
 *               success_url:
 *                 type: string
 *                 format: uri
 *               cancel_url:
 *                 type: string
 *                 format: uri
 *     responses:
 *       200:
 *         description: Checkout session URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                 session_id:
 *                   type: string
 *       400:
 *         description: Missing or invalid parameters
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Only owners and admins can manage billing
 *       404:
 *         description: Organization not found
 *       503:
 *         description: Billing not configured
 */
router.post('/create-checkout-session', requireAuth(), authRateLimiter, async (req: Request, res: Response) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Billing is not configured' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgId = await getCurrentOrgId(userId);
  if (!orgId) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const { plan, interval, success_url, cancel_url } = req.body;
  if (!plan || !interval || !success_url || !cancel_url) {
    return res.status(400).json({ error: 'plan, interval, success_url, and cancel_url are required' });
  }
  const membership = await queryOne(
    `SELECT o.*, om.role FROM org_members om
     INNER JOIN organizations o ON o.id = om.org_id
     WHERE om.user_id = ? AND om.org_id = ?`,
    [userId, orgId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const org = membership as any;
  if (org.role !== 'owner' && org.role !== 'admin') {
    return res.status(403).json({ error: 'Only owners and admins can manage billing' });
  }
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const defaultSuccess = `${frontendUrl}/app/admin?tab=billing`;
  const defaultCancel = `${frontendUrl}/app/admin?tab=billing`;
  let customerId = org.stripe_customer_id;
  if (!customerId) {
    const user = await queryOne('SELECT email, name FROM users WHERE id = ?', [userId]);
    const u = user as any;
    const customer = await stripe.customers.create({
      email: u?.email,
      name: u?.name || org.name,
      metadata: { org_id: org.id },
    });
    customerId = customer.id;
    await execute(
      'UPDATE organizations SET stripe_customer_id = ? WHERE id = ?',
      [customerId, org.id]
    );
  }
  const priceIds: Record<string, string | undefined> = {
    personal_monthly: process.env.STRIPE_PRICE_PERSONAL_MONTHLY,
    personal_yearly: process.env.STRIPE_PRICE_PERSONAL_YEARLY,
    team_monthly: process.env.STRIPE_PRICE_TEAM_MONTHLY,
    team_yearly: process.env.STRIPE_PRICE_TEAM_YEARLY,
    early_supporter: process.env.STRIPE_PRICE_EARLY_SUPPORTER,
    early_supporter_one_time: process.env.STRIPE_PRICE_EARLY_SUPPORTER,
  };
  const priceKey = interval === 'one_time' ? plan : `${plan}_${interval}`;
  const priceId = priceIds[priceKey] || priceIds[plan];
  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan or interval' });
  }
  // Validate redirect URLs to prevent open redirect (must be same-origin with frontend)
  const safeSuccessUrl = validateRedirectUrl(success_url, frontendUrl) ?? defaultSuccess;
  const safeCancelUrl = validateRedirectUrl(cancel_url, frontendUrl) ?? defaultCancel;
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer: customerId,
    mode: plan === 'early_supporter' ? 'payment' : 'subscription',
    success_url: safeSuccessUrl,
    cancel_url: safeCancelUrl,
    metadata: { org_id: org.id, plan },
  };
  if (plan === 'early_supporter') {
    sessionParams.line_items = [{ price: priceId, quantity: 1 }];
  } else {
    sessionParams.line_items = [{ price: priceId, quantity: 1 }];
    sessionParams.subscription_data = {
      metadata: { org_id: org.id, plan },
      trial_period_days: undefined,
    };
  }
  const session = await stripe.checkout.sessions.create(sessionParams);
  res.json({ url: session.url, session_id: session.id });
});

/**
 * @swagger
 * /api/billing/invoices:
 *   get:
 *     summary: List invoices for current org
 *     description: Returns invoice history for the organization's Stripe customer. Cloud mode only.
 *     tags: [Billing]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Invoice list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invoices:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       number: { type: string }
 *                       status: { type: string }
 *                       amount_paid: { type: number }
 *                       currency: { type: string }
 *                       created: { type: number }
 *                       invoice_pdf: { type: string, nullable: true }
 *                       hosted_invoice_url: { type: string, nullable: true }
 *       400:
 *         description: No billing account found
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Organization not found
 *       503:
 *         description: Billing not configured
 */
router.get('/invoices', requireAuth(), authRateLimiter, async (req: Request, res: Response) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Billing is not configured' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgId = await getCurrentOrgId(userId);
  if (!orgId) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const membership = await queryOne(
    `SELECT o.* FROM org_members om
     INNER JOIN organizations o ON o.id = om.org_id
     WHERE om.user_id = ? AND om.org_id = ?`,
    [userId, orgId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const org = membership as any;
  if (!org.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found' });
  }
  const list = await stripe.invoices.list({
    customer: org.stripe_customer_id,
    limit: 20,
  });
  const invoices = (list.data || []).map((inv) => ({
    id: inv.id,
    number: inv.number || inv.id,
    status: inv.status,
    amount_paid: inv.amount_paid ?? 0,
    currency: (inv.currency || 'eur').toUpperCase(),
    created: inv.created,
    invoice_pdf: inv.invoice_pdf || null,
    hosted_invoice_url: inv.hosted_invoice_url || null,
  }));
  res.json({ invoices });
});

/**
 * @swagger
 * /api/billing/create-portal-session:
 *   post:
 *     summary: Create Stripe Customer Portal session
 *     description: Creates a Stripe Customer Portal session for managing subscription. Cloud mode only.
 *     tags: [Billing]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               return_url:
 *                 type: string
 *                 format: uri
 *     responses:
 *       200:
 *         description: Portal session URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *       400:
 *         description: No billing account found
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Organization not found
 *       503:
 *         description: Billing not configured
 */
router.post('/create-portal-session', requireAuth(), authRateLimiter, async (req: Request, res: Response) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Billing is not configured' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgId = await getCurrentOrgId(userId);
  if (!orgId) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const { return_url } = req.body;
  const membership = await queryOne(
    `SELECT o.* FROM org_members om
     INNER JOIN organizations o ON o.id = om.org_id
     WHERE om.user_id = ? AND om.org_id = ?`,
    [userId, orgId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const org = membership as any;
  if (!org.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found' });
  }
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const defaultReturnUrl = `${frontendUrl}/app/admin?tab=billing`;
  const safeReturnUrl = validateRedirectUrl(return_url, frontendUrl) ?? defaultReturnUrl;
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: safeReturnUrl,
  });
  res.json({ url: portalSession.url });
});

/**
 * Webhook handler - must use raw body. Mount separately in index.ts with express.raw().
 */
export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  if (!isCloud) {
    res.status(404).end();
    return;
  }
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!stripe || !webhookSecret) {
    res.status(503).end();
    return;
  }
  const sig = req.headers['stripe-signature'] as string;
  const rawBody = req.body;
  if (!sig || !rawBody) {
    res.status(400).end();
    return;
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    console.error('Stripe webhook signature verification failed:', err.message);
    res.status(400).end();
    return;
  }
  const getSeatsForPlan = (plan: string) =>
    plan === 'team' ? 5 : 1;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orgId = session.metadata?.org_id;
        const plan = session.metadata?.plan;
        if (!orgId || !plan) break;
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null;
        const seats = getSeatsForPlan(plan);
        await execute(
          'UPDATE organizations SET plan = ?, included_seats = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?',
          [plan, seats, subId, orgId]
        );
        if (plan !== 'free') {
          const members = await query('SELECT user_id FROM org_members WHERE org_id = ?', [orgId]);
          const list = Array.isArray(members) ? members : members ? [members] : [];
          for (const row of list) {
            const uid = (row as any).user_id;
            if (uid) await clearFreePlanGrace(uid);
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const orgRow = await queryOne(
          'SELECT id FROM organizations WHERE stripe_subscription_id = ?',
          [sub.id]
        );
        if (orgRow) {
          const org = orgRow as any;
          const plan = sub.metadata?.plan || 'team';
          const seats = getSeatsForPlan(plan);
          await execute('UPDATE organizations SET plan = ?, included_seats = ? WHERE id = ?', [plan, seats, org.id]);
          if (plan !== 'free') {
            const members = await query('SELECT user_id FROM org_members WHERE org_id = ?', [org.id]);
            const list = Array.isArray(members) ? members : members ? [members] : [];
            for (const row of list) {
              const uid = (row as any).user_id;
              if (uid) await clearFreePlanGrace(uid);
            }
          }
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const orgRow = await queryOne(
          'SELECT id FROM organizations WHERE stripe_subscription_id = ?',
          [sub.id]
        );
        await execute(
          'UPDATE organizations SET plan = ?, included_seats = 1, stripe_subscription_id = NULL WHERE stripe_subscription_id = ?',
          ['free', sub.id]
        );
        if (orgRow) {
          const org = orgRow as any;
          const members = await query('SELECT user_id FROM org_members WHERE org_id = ?', [org.id]);
          const list = Array.isArray(members) ? members : members ? [members] : [];
          for (const row of list) {
            const uid = (row as any).user_id;
            if (uid) await setFreePlanGraceIfOverLimit(uid);
          }
        }
        break;
      }
      case 'invoice.paid':
        break;
      default:
        break;
    }
  } catch (error: any) {
    console.error('Stripe webhook handler error:', error);
    res.status(500).end();
    return;
  }
  res.json({ received: true });
}

export default router;

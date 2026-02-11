import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { authRateLimiter } from '../middleware/security.js';
import { queryOne, execute } from '../db/index.js';
import { isCloud } from '../config/mode.js';

const router = Router();

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key);
}

/**
 * GET /billing/plans — Public plan definitions (Cloud only).
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
 * POST /billing/create-checkout-session — Create Stripe Checkout session (Cloud only).
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
  const { plan, interval, success_url, cancel_url } = req.body;
  if (!plan || !interval || !success_url || !cancel_url) {
    return res.status(400).json({ error: 'plan, interval, success_url, and cancel_url are required' });
  }
  const membership = await queryOne(
    `SELECT o.*, om.role FROM org_members om
     INNER JOIN organizations o ON o.id = om.org_id
     WHERE om.user_id = ?`,
    [userId]
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
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    customer: customerId,
    mode: plan === 'early_supporter' ? 'payment' : 'subscription',
    success_url: success_url || defaultSuccess,
    cancel_url: cancel_url || defaultCancel,
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
 * POST /billing/create-portal-session — Create Stripe Customer Portal session (Cloud only).
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
  const { return_url } = req.body;
  const membership = await queryOne(
    `SELECT o.* FROM org_members om
     INNER JOIN organizations o ON o.id = om.org_id
     WHERE om.user_id = ?`,
    [userId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const org = membership as any;
  if (!org.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found' });
  }
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: return_url || `${frontendUrl}/app/admin?tab=billing`,
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
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const orgId = session.metadata?.org_id;
        const plan = session.metadata?.plan;
        if (!orgId || !plan) break;
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null;
        await execute(
          'UPDATE organizations SET plan = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?',
          [plan, subId, orgId]
        );
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
          await execute('UPDATE organizations SET plan = ? WHERE id = ?', [plan, org.id]);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await execute(
          'UPDATE organizations SET plan = ?, stripe_subscription_id = NULL WHERE stripe_subscription_id = ?',
          ['free', sub.id]
        );
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

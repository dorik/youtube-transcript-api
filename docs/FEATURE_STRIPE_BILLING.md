# Feature: Stripe Billing Integration

**Status:** Not started  
**Priority:** Critical (Tier 1)  
**Est. Effort:** 2-3 days  
**Dependencies:** Database schema, user dashboard, authentication

---

## Overview

This feature integrates Stripe for subscription billing, credit assignment, and payment processing. Users select a plan (Free, Starter $9, Pro $29, Business $79), pay via Stripe, and receive monthly credits to use the API.

### Pricing Model

| Plan | Price/mo | Monthly Credits | Use Case |
|------|----------|-----------------|----------|
| Free | $0 | 100 | Lead magnet, hobbyists |
| Starter | $9 | 2,500 | Indie devs, low volume |
| Pro | $29 | 12,000 | **Sweet spot** (target tier) |
| Business | $79 | 40,000 | Production apps |

**Credit costs:**
- Native YouTube caption: 1 credit per video (any length)
- Whisper transcription: 1 credit per minute of audio
- Free tier perks: "Latest video check" = 0 credits (monitoring endpoint)

---

## Implementation Plan

### Step 1: Create Stripe Products & Prices

In Stripe Dashboard, create recurring products:

```
Product: YouTube Transcripts - Starter
  Price: $9/month (USD)
  Billing interval: Monthly
  Metadata: {"plan_id": "starter", "credits": 2500}

Product: YouTube Transcripts - Pro
  Price: $29/month (USD)
  Billing interval: Monthly
  Metadata: {"plan_id": "pro", "credits": 12000}

Product: YouTube Transcripts - Business
  Price: $79/month (USD)
  Billing interval: Monthly
  Metadata: {"plan_id": "business", "credits": 40000}
```

Store Price IDs in environment variables:
```env
STRIPE_PRICE_ID_STARTER=price_1234567890
STRIPE_PRICE_ID_PRO=price_0987654321
STRIPE_PRICE_ID_BUSINESS=price_5555555555
```

### Step 2: Initialize Stripe SDK

**Node.js:**
```bash
npm install stripe
```

**Python:**
```bash
pip install stripe
```

**Configuration:**
```typescript
// src/services/stripeService.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
});

export { stripe };
```

### Step 3: Subscription Checkout Flow

**Goal:** Create a checkout session when user selects a paid plan.

**Flow:**
1. User selects plan (Starter, Pro, Business)
2. Backend creates Stripe checkout session
3. Frontend redirects to Stripe Checkout page
4. User enters payment info
5. Stripe creates subscription
6. Stripe redirects back to success page
7. Webhook confirms payment and activates subscription

**Implementation:**

```typescript
// src/routes/billing.ts
import express from 'express';
import { authenticateUser } from '../middleware/auth';
import { stripe } from '../services/stripeService';

const router = express.Router();

router.post('/create-checkout-session', authenticateUser, async (req, res) => {
  try {
    const { plan } = req.body;
    const user = req.user;

    // Validate plan
    const planConfig = {
      starter: { priceId: process.env.STRIPE_PRICE_ID_STARTER, credits: 2500 },
      pro: { priceId: process.env.STRIPE_PRICE_ID_PRO, credits: 12000 },
      business: { priceId: process.env.STRIPE_PRICE_ID_BUSINESS, credits: 40000 },
    };

    if (!planConfig[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const { priceId } = planConfig[plan];

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer_email: user.email,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.APP_URL}/dashboard/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/dashboard/billing/cancel`,
      metadata: {
        user_id: user.id,
        plan,
      },
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

export default router;
```

**Frontend (React):**

```typescript
// src/components/BillingPlans.tsx
import { loadStripe } from '@stripe/js';

const BillingPlans = () => {
  const handleSelectPlan = async (plan: string) => {
    const response = await fetch('/api/billing/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });

    const { sessionId } = await response.json();
    const stripe = await loadStripe(process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY);
    stripe.redirectToCheckout({ sessionId });
  };

  return (
    <div>
      <button onClick={() => handleSelectPlan('starter')}>
        Starter - $9/mo
      </button>
      <button onClick={() => handleSelectPlan('pro')}>
        Pro - $29/mo
      </button>
      <button onClick={() => handleSelectPlan('business')}>
        Business - $79/mo
      </button>
    </div>
  );
};
```

### Step 4: Webhook Handling

**Goal:** Listen to Stripe events and update database.

**Events to handle:**
- `customer.subscription.created` — New subscription
- `customer.subscription.updated` — Plan change
- `customer.subscription.deleted` — Cancellation
- `payment_intent.succeeded` — Payment successful
- `charge.failed` — Payment failed

**Webhook setup:**
1. Go to Stripe Dashboard → Webhooks
2. Add endpoint: `https://yourdomain.com/webhooks/stripe`
3. Select events: subscription.created, subscription.updated, subscription.deleted, charge.failed
4. Copy signing secret to `.env`

**Implementation:**

```typescript
// src/routes/webhooks.ts
import express from 'express';
import { stripe } from '../services/stripeService';
import { handleSubscriptionCreated, handleSubscriptionUpdated, handleSubscriptionDeleted, handleChargeFailed } from '../services/subscriptionService';

const router = express.Router();

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error(`Webhook signature verification failed.`, error);
    return res.sendStatus(400);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      case 'charge.failed':
        await handleChargeFailed(event.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handling error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
```

### Step 5: Subscription Service

```typescript
// src/services/subscriptionService.ts
import { db } from '../db';
import { stripe } from './stripeService';

const PLAN_CONFIG = {
  starter: { name: 'Starter', credits: 2500 },
  pro: { name: 'Pro', credits: 12000 },
  business: { name: 'Business', credits: 40000 },
};

export async function handleSubscriptionCreated(subscription: Stripe.Subscription) {
  const metadata = subscription.metadata;
  const userId = metadata.user_id;
  const plan = metadata.plan;

  // Get customer email from Stripe
  const customer = await stripe.customers.retrieve(subscription.customer as string);

  // Find user by email (in case metadata is missing)
  const userResult = await db.query('SELECT id FROM users WHERE email = $1', [customer.email]);
  const finalUserId = userId || userResult.rows[0]?.id;

  if (!finalUserId) {
    console.error('User not found for subscription:', subscription.id);
    return;
  }

  const planConfig = PLAN_CONFIG[plan] || PLAN_CONFIG.pro;
  const now = new Date();
  const nextBillingDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Begin transaction
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Create/update subscription
    await client.query(
      `INSERT INTO subscriptions 
       (user_id, plan_id, plan_name, monthly_credits, stripe_customer_id, stripe_subscription_id, status, billing_cycle_start, billing_cycle_end)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), $7)
       ON CONFLICT (user_id) DO UPDATE SET
         plan_id = $2,
         plan_name = $3,
         monthly_credits = $4,
         stripe_subscription_id = $6,
         status = 'active'`,
      [finalUserId, plan, planConfig.name, planConfig.credits, subscription.customer, subscription.id, nextBillingDate]
    );

    // Reset credits for new month
    await client.query(
      `INSERT INTO credits (user_id, balance, total_allocated, last_reset_at, next_reset_at)
       VALUES ($1, $2, $2, NOW(), $3)
       ON CONFLICT (user_id) DO UPDATE SET
         balance = $2,
         total_allocated = total_allocated + $2,
         last_reset_at = NOW(),
         next_reset_at = $3`,
      [finalUserId, planConfig.credits, nextBillingDate]
    );

    // Log billing event
    await client.query(
      `INSERT INTO billing_events (user_id, stripe_event_id, event_type, stripe_subscription_id, credits_issued, status, processed)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [finalUserId, subscription.id, 'customer.subscription.created', subscription.id, planConfig.credits, 'succeeded']
    );

    await client.query('COMMIT');
    console.log(`Subscription created for user ${finalUserId}: ${plan} plan with ${planConfig.credits} credits`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  // Handle plan upgrades/downgrades
  const oldStatus = subscription.status;
  const newStatus = subscription.status;

  if (oldStatus !== newStatus) {
    // Status changed (e.g., past_due)
    await db.query(
      'UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2',
      [newStatus, subscription.id]
    );
  }
}

export async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  // Mark subscription as cancelled
  await db.query(
    'UPDATE subscriptions SET status = $1, cancelled_at = NOW() WHERE stripe_subscription_id = $2',
    ['cancelled', subscription.id]
  );
}

export async function handleChargeFailed(charge: Stripe.Charge) {
  // Mark subscription as past_due
  if (charge.invoice) {
    const invoice = await stripe.invoices.retrieve(charge.invoice as string);
    await db.query(
      'UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2',
      ['past_due', invoice.subscription]
    );

    // Notify user (send email, etc.)
    console.warn(`Payment failed for subscription ${invoice.subscription}`);
  }
}
```

### Step 6: Credit Reset (Monthly)

**Goal:** Reset user credits at the start of each billing cycle.

**Implementation (as a cron job):**

```typescript
// src/jobs/creditReset.ts
import { db } from '../db';

export async function resetMonthlyCredits() {
  const now = new Date();

  // Find all subscriptions where billing_cycle_end has passed
  const result = await db.query(
    `SELECT id, user_id, monthly_credits 
     FROM subscriptions 
     WHERE billing_cycle_end < NOW() AND status = 'active'`
  );

  for (const sub of result.rows) {
    const nextCycleEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Reset credits
      await client.query(
        `UPDATE credits 
         SET balance = $1, total_allocated = total_allocated + $1, last_reset_at = NOW(), next_reset_at = $3
         WHERE user_id = $2`,
        [sub.monthly_credits, sub.user_id, nextCycleEnd]
      );

      // Update subscription cycle dates
      await client.query(
        `UPDATE subscriptions 
         SET billing_cycle_start = NOW(), billing_cycle_end = $2 
         WHERE id = $1`,
        [sub.id, nextCycleEnd]
      );

      // Log transaction
      await client.query(
        `INSERT INTO credit_transactions (user_id, amount, reason)
         VALUES ($1, $2, 'monthly_reset')`,
        [sub.user_id, sub.monthly_credits]
      );

      await client.query('COMMIT');
      console.log(`Reset ${sub.monthly_credits} credits for user ${sub.user_id}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed to reset credits for user ${sub.user_id}:`, error);
    } finally {
      client.release();
    }
  }
}

// Schedule with node-cron
import cron from 'node-cron';
cron.schedule('0 0 * * *', resetMonthlyCredits); // Midnight every day
```

### Step 7: Free Plan Upgrade Handler

**Goal:** Auto-create free subscription for new users.

```typescript
// src/services/userService.ts
export async function createUser(email: string, password: string): Promise<User> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Insert user
    const userResult = await client.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, hashPassword(password)]
    );
    const userId = userResult.rows[0].id;

    // Create free subscription
    const nextCycleEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO subscriptions (user_id, plan_id, plan_name, monthly_credits, billing_cycle_start, billing_cycle_end, status)
       VALUES ($1, 'free', 'Free', 100, NOW(), $2, 'active')`,
      [userId, nextCycleEnd]
    );

    // Initialize credits
    await client.query(
      `INSERT INTO credits (user_id, balance, total_allocated, last_reset_at, next_reset_at)
       VALUES ($1, 100, 100, NOW(), $2)`,
      [userId, nextCycleEnd]
    );

    await client.query('COMMIT');
    return { id: userId, email };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

## Testing

### Unit Tests

```typescript
describe('Stripe Billing', () => {
  it('should create checkout session for valid plan', async () => {
    const response = await request(app)
      .post('/api/billing/create-checkout-session')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ plan: 'pro' });

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBeDefined();
  });

  it('should reject invalid plan', async () => {
    const response = await request(app)
      .post('/api/billing/create-checkout-session')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ plan: 'invalid' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid plan');
  });

  it('should handle subscription webhook', async () => {
    const event = {
      type: 'customer.subscription.created',
      data: {
        object: mockStripeSubscription,
      },
    };

    const signature = stripe.webhooks.generateTestHeaderString({
      payload: JSON.stringify(event),
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });

    const response = await request(app)
      .post('/webhooks/stripe')
      .set('Stripe-Signature', signature)
      .send(event);

    expect(response.status).toBe(200);

    // Verify subscription created in database
    const result = await db.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
    expect(result.rows[0].plan_id).toBe('pro');
    expect(result.rows[0].monthly_credits).toBe(12000);
  });

  it('should reset credits monthly', async () => {
    // Set billing_cycle_end to past date
    await db.query(
      'UPDATE subscriptions SET billing_cycle_end = NOW() - INTERVAL 1 DAY WHERE user_id = $1',
      [userId]
    );

    await resetMonthlyCredits();

    const result = await db.query('SELECT * FROM credits WHERE user_id = $1', [userId]);
    expect(result.rows[0].balance).toBe(12000); // Pro plan credits
  });
});
```

### Integration Tests

```typescript
describe('Billing Integration', () => {
  it('should complete end-to-end checkout and subscription flow', async () => {
    // 1. Create user
    const userEmail = `test-${Date.now()}@example.com`;
    const userResponse = await request(app)
      .post('/api/signup')
      .send({ email: userEmail, password: 'testPassword123' });

    const userId = userResponse.body.user_id;

    // 2. Simulate checkout
    const checkoutResponse = await request(app)
      .post('/api/billing/create-checkout-session')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ plan: 'pro' });

    expect(checkoutResponse.status).toBe(200);

    // 3. Simulate Stripe webhook
    const mockSubscription = {
      id: 'sub_test123',
      customer: 'cus_test123',
      status: 'active',
      metadata: { user_id: userId, plan: 'pro' },
    };

    const webhook = {
      type: 'customer.subscription.created',
      data: { object: mockSubscription },
    };

    const signature = stripe.webhooks.generateTestHeaderString({
      payload: JSON.stringify(webhook),
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });

    const webhookResponse = await request(app)
      .post('/webhooks/stripe')
      .set('Stripe-Signature', signature)
      .send(webhook);

    expect(webhookResponse.status).toBe(200);

    // 4. Verify subscription and credits
    const subResult = await db.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
    expect(subResult.rows[0].plan_id).toBe('pro');

    const creditsResult = await db.query('SELECT * FROM credits WHERE user_id = $1', [userId]);
    expect(creditsResult.rows[0].balance).toBe(12000);
  });
});
```

---

## Monitoring & Alerts

**Metrics to track:**
- Conversion rate (free → paid)
- Churn rate (paid cancellations)
- Plan distribution (% Pro vs Business)
- Payment failure rate
- Failed webhook processing

**Alerts:**
- Payment failure > 5%
- Webhook processing errors
- Stripe API quota exceeded
- Unhandled webhook events

---

## Deployment Checklist

- [ ] Stripe account created and configured
- [ ] Products and prices created in Stripe
- [ ] API keys added to `.env`
- [ ] Webhook endpoint deployed and registered with Stripe
- [ ] Webhook signature verification tested
- [ ] Database transactions tested
- [ ] Credit reset cron job scheduled
- [ ] Monitoring/alerting configured
- [ ] Payment flow tested in staging with Stripe test cards
- [ ] Documentation updated with billing flow

---

## Test Card Numbers (Stripe)

**Visa:** 4242 4242 4242 4242 (succeeds)  
**Visa (requires auth):** 4000 0025 0000 3155  
**Visa (declines):** 4000 0000 0000 0002  
**Amex:** 3782 822463 10005  

**Expiry:** Any future date (e.g., 12/25)  
**CVC:** Any 3-digit number

---

**Status:** Ready for implementation  
**Version:** 1.0  
**Last Updated:** 2026-05-09

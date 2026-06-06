// ─────────────────────────────────────────────────────
// UPLOAD THIS FILE TO GITHUB AS:  api/webhook.js
// ─────────────────────────────────────────────────────
// Stripe calls this URL automatically when payments happen.
// It updates your Supabase database to mark users as Premium.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Use the SERVICE ROLE key here (server-side only — never in browser code)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Disable Vercel's body parser so we can verify Stripe's signature
export const config = { api: { bodyParser: false } };

// Read raw request body (needed for Stripe signature verification)
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Handle Stripe events ──
  switch (event.type) {

    case 'checkout.session.completed': {
      // User paid! Mark them as Premium in Supabase.
      const session = event.data.object;
      const userId  = session.client_reference_id;
      if (userId) {
        await supabase.from('profiles').upsert({
          user_id:             userId,
          is_premium:          true,
          stripe_customer_id:  session.customer,
          subscription_status: 'active',
          premium_started_at:  new Date().toISOString(),
          updated_at:          new Date().toISOString(),
        }, { onConflict: 'user_id' });
        console.log(`✅ Premium activated for user ${userId}`);
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      // Monthly renewal — keep Premium active
      const invoice     = event.data.object;
      const customerId  = invoice.customer;
      const { data: profile } = await supabase
        .from('profiles').select('user_id').eq('stripe_customer_id', customerId).single();
      if (profile) {
        await supabase.from('profiles')
          .update({ subscription_status: 'active', updated_at: new Date().toISOString() })
          .eq('user_id', profile.user_id);
      }
      break;
    }

    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      // Subscription cancelled or payment failed — downgrade to Free
      const obj        = event.data.object;
      const customerId = obj.customer;
      const { data: profile } = await supabase
        .from('profiles').select('user_id').eq('stripe_customer_id', customerId).single();
      if (profile) {
        await supabase.from('profiles')
          .update({ is_premium: false, subscription_status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('user_id', profile.user_id);
        console.log(`❌ Premium removed for user ${profile.user_id}`);
      }
      break;
    }
  }

  res.status(200).json({ received: true });
}

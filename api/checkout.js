// ─────────────────────────────────────────────────────
// UPLOAD THIS FILE TO GITHUB AS:  api/checkout.js
// (create an "api" folder in your GitHub repo first)
// ─────────────────────────────────────────────────────
// This function creates a Stripe Checkout session.
// Vercel runs it automatically as a free serverless function.

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, userEmail } = req.body;
    if (!userId || !userEmail) return res.status(400).json({ error: 'Missing userId or userEmail' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: userEmail,
      client_reference_id: userId,           // links Stripe payment to Supabase user
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: 'https://getfiniq.vercel.app/dashboard.html?payment=success',
      cancel_url:  'https://getfiniq.vercel.app/dashboard.html?payment=cancelled',
      subscription_data: {
        metadata: { supabase_user_id: userId },
      },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

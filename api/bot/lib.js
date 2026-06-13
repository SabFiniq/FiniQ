// ─────────────────────────────────────────────────────
// UPLOAD AS: api/bot/_lib.js
// Shared helpers used by telegram.js, whatsapp.js, digest-cron.js
// ─────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';

export const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Same 25 categories as dashboard.html — keep in sync if you add categories there.
export const CATS = [
  {id:'groceries',     label:'Groceries'},
  {id:'medical',       label:'Hospital & Medicine'},
  {id:'clothing',      label:'Clothing & Fashion'},
  {id:'pets',          label:'Pet Care & Pet Food'},
  {id:'fuel',          label:'Diesel / Petrol'},
  {id:'maintenance',   label:'Maintenance & Accessories'},
  {id:'dining',        label:'Dining & Outside Food'},
  {id:'toys',          label:'Toys, Games & Hobbies'},
  {id:'utilities',     label:'Electricity & Gas Bill'},
  {id:'rent',          label:'Home Rent'},
  {id:'telecom',       label:'WiFi & Mobile Recharge'},
  {id:'car_insurance', label:'Car Insurance'},
  {id:'health_ins',    label:'Medical Insurance'},
  {id:'vacation',      label:'Vacation & Travel'},
  {id:'emi',           label:'EMI / Loan Repayment'},
  {id:'education',     label:'Education & Courses'},
  {id:'fitness',       label:'Gym, Fitness & Protein'},
  {id:'streaming',     label:'Subscriptions & Streaming'},
  {id:'school_fees',   label:"Children's School Fees"},
  {id:'home_repair',   label:'Home Repair & Renovation'},
  {id:'gifts',         label:'Gifts & Celebrations'},
  {id:'personal_care', label:'Personal Care & Salon'},
  {id:'savings',       label:'Savings & Investment'},
  {id:'charity',       label:'Charity & Donations'},
  {id:'misc',          label:'Miscellaneous'},
  {id:'remittance',    label:'Money Sent Home'},
];

export const SYM = {INR:'₹', USD:'$', EUR:'€', GBP:'£', AED:'د.إ', CAD:'C$', AUD:'A$', SGD:'S$', QAR:'﷼', SAR:'﷼'};

export const FX_FALLBACK = { USD:1, INR:86, EUR:0.92, GBP:0.78, AED:3.67, CAD:1.37, AUD:1.53, SGD:1.29, QAR:3.64, SAR:3.75 };

let _fxCache = null; // {date, rates} — per cold-start cache
export async function getFxRates() {
  const today = new Date().toISOString().slice(0,10);
  if (_fxCache && _fxCache.date === today) return _fxCache.rates;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await r.json();
    if (data && data.result === 'success' && data.rates) {
      _fxCache = { date: today, rates: data.rates };
      return data.rates;
    }
  } catch (e) { /* fall through */ }
  return FX_FALLBACK;
}

export function convertAmt(amount, from, to, rates) {
  if (!from || from === to) return amount;
  const rf = rates[from], rt = rates[to];
  if (!rf || !rt) return amount;
  return (amount / rf) * rt;
}

export function fmt(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// ── Outbound senders (used by digest-cron.js) ────────
export async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

export async function sendWhatsApp(to, text) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return;
  // NOTE: outside the 24h customer-service window, WhatsApp requires a
  // pre-approved message TEMPLATE for proactive sends like digests. This
  // free-form call will silently fail until you create & approve one
  // (see FiniQ-Bot-Build-Guide.md). Swap the body for a `template` object
  // once approved.
  await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
}

// ── Account linking ──────────────────────────────────
export async function getUserByChatId(platform, chatId) {
  const { data } = await db.from('bot_links')
    .select('user_id').eq('platform', platform).eq('chat_id', String(chatId)).maybeSingle();
  return data ? data.user_id : null;
}

// Consumes a one-time code generated from the dashboard's "Connect Bot" screen.
export async function consumeLinkCode(code, platform, chatId) {
  const { data: row } = await db.from('link_codes')
    .select('*').eq('code', code).eq('used', false).maybeSingle();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  await db.from('link_codes').update({ used: true }).eq('code', code);
  await db.from('bot_links').upsert(
    { user_id: row.user_id, platform, chat_id: String(chatId) },
    { onConflict: 'platform,chat_id' }
  );
  // Ensure bot_settings row exists
  await db.from('bot_settings').upsert({ user_id: row.user_id }, { onConflict: 'user_id' });
  return row.user_id;
}

// ── Premium check ────────────────────────────────────
export async function isPremium(userId) {
  const { data } = await db.from('profiles')
    .select('is_premium').eq('user_id', userId).maybeSingle();
  return !!(data && data.is_premium);
}

// ── Bot access check: Premium subscriber OR still inside the 14-day
// free trial (mirrors TRIAL_DAYS / inTrial logic in dashboard.html). ──
const TRIAL_DAYS = 14;
export async function hasBotAccess(userId) {
  const { data: profile } = await db.from('profiles')
    .select('is_premium').eq('user_id', userId).maybeSingle();
  if (profile?.is_premium) return { access: true, reason: 'premium' };

  try {
    // Auth Admin API (service-role only) — same `created_at` used
    // client-side to compute the trial window in dashboard.html.
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error || !data?.user) return { access: false, reason: 'unknown' };

    const createdAt = new Date(data.user.created_at);
    const trialEnd = new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const now = new Date();
    const inTrial = now < trialEnd;
    const trialDaysLeft = Math.max(0, Math.ceil((trialEnd - now) / (24 * 60 * 60 * 1000)));
    return { access: inTrial, reason: inTrial ? 'trial' : 'trial_expired', trialDaysLeft };
  } catch (e) {
    return { access: false, reason: 'unknown' };
  }
}

// ── Settings ──────────────────────────────────────────
export async function getBotSettings(userId) {
  const { data } = await db.from('bot_settings').select('*').eq('user_id', userId).maybeSingle();
  return data || { home_currency: 'EUR', digest_frequency: 'weekly', digest_day: 1, budget_alerts: true };
}

// ── Logging an expense ───────────────────────────────
export async function logExpense(userId, { amount, currency, category, type, note, date }) {
  const payload = {
    user_id: userId,
    amount, currency, category: category || 'misc',
    type: type || 'expense',
    note: note || '',
    date: date || new Date().toISOString().slice(0,10),
  };
  const { error } = await db.from('expenses').insert(payload);
  return { ok: !error, error };
}

// ── Net worth / goals snapshot (mirrors renderNetWorth() in dashboard.html) ──
export async function getNetWorthSnapshot(userId) {
  const settings = await getBotSettings(userId);
  const home = settings.home_currency || 'EUR';
  const rates = await getFxRates();

  const { data: savingsRows } = await db.from('expenses')
    .select('amount,currency').eq('user_id', userId).eq('category', 'savings');
  let savingsTotal = 0;
  (savingsRows || []).forEach(r => { savingsTotal += convertAmt(Number(r.amount)||0, r.currency, home, rates); });

  const { data: goals } = await db.from('goals').select('*').eq('user_id', userId);
  let goalsTotal = 0;
  (goals || []).forEach(g => { goalsTotal += convertAmt(Number(g.current)||0, g.currency, home, rates); });

  return {
    home, sym: SYM[home] || home,
    savingsTotal, goalsTotal,
    netWorth: savingsTotal + goalsTotal,
    goals: goals || [],
    rates,
  };
}

// ── Budget alert: has this category crossed its monthly limit? ──
// Assumes a `budgets` table with columns (user_id, category, amount) where
// `amount` is a fixed MONTHLY limit in the expense's own currency (matches
// dashboard.html's Goals & Insights tab). Adjust column names below if your
// schema differs. Fails silently (returns null) if anything is missing.
export async function checkBudgetAlert(userId, category) {
  try {
    const { data: budget } = await db.from('budgets')
      .select('amount').eq('user_id', userId).eq('category', category).maybeSingle();
    if (!budget || !budget.amount) return null;

    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const { data: rows } = await db.from('expenses')
      .select('amount,currency').eq('user_id', userId).eq('category', category)
      .gte('date', monthStart);

    const rates = await getFxRates();
    let spent = 0;
    (rows || []).forEach(r => { spent += convertAmt(Number(r.amount)||0, r.currency, 'EUR', rates); });
    const limitEur = convertAmt(Number(budget.amount)||0, 'EUR', 'EUR', rates); // assumes limit stored in EUR-equivalent; adjust if not

    const pct = limitEur > 0 ? (spent / limitEur) * 100 : 0;
    if (pct >= 100) return { level: 'over', pct: Math.round(pct) };
    if (pct >= 80)  return { level: 'warn', pct: Math.round(pct) };
    return null;
  } catch (e) {
    return null; // budgets table missing/different shape — skip alert
  }
}

// ── Spend-vs-goal nudge text after logging an expense ──
export function goalNudge(snapshot, expenseAmount, expenseCurrency) {
  if (!snapshot.goals || snapshot.goals.length === 0) return null;
  // Highlight the nearest-deadline goal that isn't complete
  const open = snapshot.goals
    .filter(g => Number(g.current) < Number(g.target))
    .sort((a,b) => new Date(a.deadline||'9999-12-31') - new Date(b.deadline||'9999-12-31'));
  if (open.length === 0) return null;
  const g = open[0];
  const pct = Math.min(100, Math.round((Number(g.current) / Number(g.target)) * 100));
  const amtInGoalCcy = convertAmt(expenseAmount, expenseCurrency, g.currency, snapshot.rates);
  const pctOfGoal = ((amtInGoalCcy / Number(g.target)) * 100).toFixed(1);
  return `${g.emoji||'🎯'} ${g.name}: ${pct}% saved. This expense is ~${pctOfGoal}% of that goal's target.`;
}

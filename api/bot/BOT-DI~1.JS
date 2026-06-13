// ─────────────────────────────────────────────────────
// UPLOAD AS: api/bot/digest-cron.js
// Runs daily (via Vercel Cron, see vercel.json) and sends weekly/monthly
// digests to Premium users who've enabled them (bot_settings.digest_frequency).
//
// SECURITY: protect this endpoint so only Vercel Cron can trigger it.
// Set a VERCEL ENV VAR  CRON_SECRET  to a random string, and Vercel will
// automatically send it as "Authorization: Bearer <CRON_SECRET>".
// ─────────────────────────────────────────────────────
import {
  db, SYM, fmt, getFxRates, convertAmt, getNetWorthSnapshot,
  hasBotAccess, sendTelegram, sendWhatsApp,
} from './_lib.js';

const NON_EXPENSE_TYPES = ['income', 'tax', 'allowance', 'savings'];

function isoWeekday(d) { // 1=Mon ... 7=Sun
  const wd = d.getDay();
  return wd === 0 ? 7 : wd;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET &&
      req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  const now = new Date();
  const todayWeekday = isoWeekday(now);
  const isFirstOfMonth = now.getDate() === 1;

  // Find users whose digest is due today
  const { data: settingsRows } = await db.from('bot_settings')
    .select('*')
    .or(
      `and(digest_frequency.eq.weekly,digest_day.eq.${todayWeekday})` +
      (isFirstOfMonth ? `,digest_frequency.eq.monthly` : '')
    );

  let sent = 0;
  for (const settings of settingsRows || []) {
    try {
      if (!(await hasBotAccess(settings.user_id)).access) continue;

      const { data: links } = await db.from('bot_links').select('*').eq('user_id', settings.user_id);
      if (!links || links.length === 0) continue;

      const periodDays = settings.digest_frequency === 'monthly' ? 30 : 7;
      const since = new Date(now.getTime() - periodDays * 86400000).toISOString().slice(0, 10);
      const home = settings.home_currency || 'EUR';
      const sym = SYM[home] || home;
      const rates = await getFxRates();

      const { data: rows } = await db.from('expenses')
        .select('amount,currency,category,type')
        .eq('user_id', settings.user_id)
        .gte('date', since);

      let totalSpent = 0;
      const byCategory = {};
      let takeHome = 0;
      (rows || []).forEach(r => {
        const amt = convertAmt(Number(r.amount) || 0, r.currency, home, rates);
        if (r.type === 'income') takeHome += amt;
        else if (r.type === 'tax') takeHome -= amt;
        else if (r.type === 'allowance') takeHome += amt;
        else if (!NON_EXPENSE_TYPES.includes(r.type)) {
          totalSpent += amt;
          byCategory[r.category] = (byCategory[r.category] || 0) + amt;
        }
      });

      let topCat = null, topAmt = 0;
      for (const [cat, amt] of Object.entries(byCategory)) {
        if (amt > topAmt) { topAmt = amt; topCat = cat; }
      }

      const snap = await getNetWorthSnapshot(settings.user_id);
      const periodLabel = settings.digest_frequency === 'monthly' ? 'Last 30 days' : 'Last 7 days';

      const lines = [
        `📊 *FiniQ ${settings.digest_frequency === 'monthly' ? 'Monthly' : 'Weekly'} Digest*`,
        `${periodLabel}:`,
        `💸 Spent: ${sym}${fmt(totalSpent)}`,
      ];
      if (topCat) lines.push(`🔥 Biggest category: ${topCat} (${sym}${fmt(topAmt)})`);
      if (takeHome) lines.push(`💵 Take-home: ${sym}${fmt(takeHome)}`);
      lines.push(`💎 Net worth: ${snap.sym}${fmt(snap.netWorth)}`);
      const text = lines.join('\n');

      for (const link of links) {
        if (link.platform === 'telegram') await sendTelegram(link.chat_id, text);
        if (link.platform === 'whatsapp') await sendWhatsApp(link.chat_id, text);
      }
      sent++;
    } catch (e) {
      console.error('Digest error for user', settings.user_id, e);
    }
  }

  return res.status(200).json({ ok: true, sent });
}

// ─────────────────────────────────────────────────────
// UPLOAD AS: api/bot/whatsapp.js
// WhatsApp Cloud API webhook (Meta).
//
// SETUP (Meta side — see FiniQ-Bot-Build-Guide.md for full steps):
//  1. Create a Meta App + WhatsApp product, get a test number.
//  2. Set webhook URL to https://getfiniq.app/api/bot/whatsapp
//     and Verify Token to WHATSAPP_VERIFY_TOKEN below.
//  3. Subscribe to the "messages" field.
//
// REQUIRES VERCEL ENV VARS:
//   WHATSAPP_ACCESS_TOKEN     (permanent token from System User)
//   WHATSAPP_PHONE_NUMBER_ID
//   WHATSAPP_VERIFY_TOKEN     (any string you choose, must match Meta config)
//   OPENAI_API_KEY            (for _parse.js)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// ─────────────────────────────────────────────────────
import {
  db, CATS, SYM, fmt, getUserByChatId, consumeLinkCode, hasBotAccess,
  getBotSettings, logExpense, getNetWorthSnapshot, goalNudge, checkBudgetAlert,
} from './_lib.js';
import { parseExpenseText, parseReceiptImage, transcribeAudio } from './_parse.js';

const GRAPH = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}`;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const START_MSG =
`👋 Welcome to FiniQ Bot!

I log expenses straight into your FiniQ dashboard from a text, voice note, or receipt photo.

Step 1: Open FiniQ → 🤖 Bot tab → "Connect Bot" → copy your code
Step 2: Reply with: /link 123456

Once linked, just send things like:
"₹450 lunch at Zomato"
"saved 100 EUR"
"sent 200 GBP home"
...or a voice note, or a photo of a receipt.

Commands:
/networth — total net worth
/goals — savings goals progress
/currency EUR — set your display currency
/help — show this message`;

async function waSend(to, text) {
  await fetch(`${GRAPH}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
}

async function waMediaBuffer(mediaId) {
  const meta = await (await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  })).json();
  const fileRes = await fetch(meta.url, { headers: { 'Authorization': `Bearer ${TOKEN}` } });
  return { buf: Buffer.from(await fileRes.arrayBuffer()), mime: meta.mime_type };
}

export default async function handler(req, res) {
  // ── Webhook verification (Meta calls this once when you set the webhook) ──
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg) return res.status(200).json({ ok: true }); // status updates etc.

    const from = msg.from; // phone number, used as chat_id
    const text = (msg.text?.body || '').trim();

    // ── Commands that don't need a linked account ──
    if (text === '/start' || text === '/help') {
      await waSend(from, START_MSG);
      return res.status(200).json({ ok: true });
    }

    if (text.toLowerCase().startsWith('/link')) {
      const code = (text.split(/\s+/)[1] || '').toUpperCase();
      if (!code) {
        await waSend(from, 'Usage: /link 123456 — get this code from FiniQ Dashboard → 🤖 Bot tab.');
      } else {
        const uid = await consumeLinkCode(code, 'whatsapp', from);
        await waSend(from, uid
          ? '✅ Linked! Send me expenses anytime — text, voice note, or a receipt photo.'
          : '❌ Invalid or expired code. Generate a new one from the FiniQ dashboard.');
      }
      return res.status(200).json({ ok: true });
    }

    // ── Everything below needs a linked + Premium account ──
    const userId = await getUserByChatId('whatsapp', from);
    if (!userId) {
      await waSend(from, "You're not linked yet. Send /start to get set up.");
      return res.status(200).json({ ok: true });
    }
    const access = await hasBotAccess(userId);
    if (!access.access) {
      await waSend(from, access.reason === 'trial_expired'
        ? '⏰ Your 14-day free FiniQ trial has ended, so FiniQ Bot is now a Premium feature. Upgrade at https://getfiniq.app/dashboard.html to keep logging expenses by chat.'
        : '🔒 FiniQ Bot is a Premium feature. Upgrade at https://getfiniq.app/dashboard.html to unlock chat-based expense logging.');
      return res.status(200).json({ ok: true });
    }
    // Gentle reminder near the end of the trial (Premium users won't see this)
    const trialNote = (access.reason === 'trial' && access.trialDaysLeft <= 3)
      ? `\n\n🎁 ${access.trialDaysLeft} day${access.trialDaysLeft === 1 ? '' : 's'} left in your free trial — upgrade at https://getfiniq.app/dashboard.html to keep FiniQ Bot.`
      : '';

    const settings = await getBotSettings(userId);

    if (text.toLowerCase().startsWith('/networth')) {
      const snap = await getNetWorthSnapshot(userId);
      await waSend(from,
        `💎 Total Net Worth: ${snap.sym}${fmt(snap.netWorth)}\n` +
        `🎯 Saved toward goals: ${snap.sym}${fmt(snap.goalsTotal)}\n` +
        `📈 Saved & invested: ${snap.sym}${fmt(snap.savingsTotal)}`);
      return res.status(200).json({ ok: true });
    }

    if (text.toLowerCase().startsWith('/goals')) {
      const snap = await getNetWorthSnapshot(userId);
      if (!snap.goals.length) {
        await waSend(from, 'No goals yet — add one in FiniQ → Goals & Insights tab.');
      } else {
        const lines = snap.goals.map(g => {
          const pct = Math.min(100, Math.round((Number(g.current) / Number(g.target)) * 100));
          const s = SYM[g.currency] || g.currency;
          return `${g.emoji || '🎯'} ${g.name}: ${pct}% (${s}${fmt(g.current)} / ${s}${fmt(g.target)})`;
        });
        await waSend(from, lines.join('\n'));
      }
      return res.status(200).json({ ok: true });
    }

    if (text.toLowerCase().startsWith('/currency')) {
      const code = (text.split(/\s+/)[1] || '').toUpperCase();
      if (!SYM[code]) {
        await waSend(from, 'Supported currencies: ' + Object.keys(SYM).join(', '));
      } else {
        await db.from('bot_settings').upsert({ user_id: userId, home_currency: code }, { onConflict: 'user_id' });
        await waSend(from, `✅ Display currency set to ${code}`);
      }
      return res.status(200).json({ ok: true });
    }

    // ── Parse the actual expense (text / voice / photo) ──
    let parsed;
    if (msg.type === 'audio' && msg.audio) {
      const { buf } = await waMediaBuffer(msg.audio.id);
      const transcript = await transcribeAudio(buf, 'voice.ogg');
      parsed = await parseExpenseText(transcript, settings.home_currency);
    } else if (msg.type === 'image' && msg.image) {
      const { buf, mime } = await waMediaBuffer(msg.image.id);
      const b64 = `data:${mime};base64,${buf.toString('base64')}`;
      parsed = await parseReceiptImage(b64, settings.home_currency, msg.image.caption || '');
    } else if (text) {
      parsed = await parseExpenseText(text, settings.home_currency);
    } else {
      await waSend(from, 'Send me an expense as text, a voice note, or a receipt photo 🙂');
      return res.status(200).json({ ok: true });
    }

    if (!parsed || parsed.error || !parsed.amount) {
      await waSend(from, "Couldn't find an amount in that. Try e.g. \"€12 lunch\" or \"saved 100 EUR\".");
      return res.status(200).json({ ok: true });
    }

    await logExpense(userId, parsed);

    const cat = CATS.find(c => c.id === parsed.category);
    const snap = await getNetWorthSnapshot(userId);

    let reply = `✅ Logged ${parsed.currency} ${fmt(parsed.amount)} — ${cat ? cat.label : 'Misc'}${parsed.note ? ` (${parsed.note})` : ''}`;

    if (parsed.type === 'savings') {
      reply += `\n💎 Net worth: ${snap.sym}${fmt(snap.netWorth)}`;
    } else {
      const nudge = goalNudge(snap, parsed.amount, parsed.currency);
      if (nudge) reply += `\n${nudge}`;
    }

    if (settings.budget_alerts && parsed.type === 'expense') {
      const alert = await checkBudgetAlert(userId, parsed.category);
      if (alert) {
        reply += alert.level === 'over'
          ? `\n⚠️ You're at ${alert.pct}% of your ${cat ? cat.label : parsed.category} budget this month!`
          : `\n⚠️ Heads up: ${alert.pct}% of your ${cat ? cat.label : parsed.category} budget used.`;
      }
    }

    await waSend(from, reply + trialNote);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('WhatsApp bot error:', err);
    return res.status(200).json({ ok: true });
  }
}

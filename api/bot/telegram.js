// ─────────────────────────────────────────────────────
// UPLOAD AS: api/bot/telegram.js
// Telegram webhook — set with:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://getfiniq.app/api/bot/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
//
// REQUIRES VERCEL ENV VARS:
//   TELEGRAM_BOT_TOKEN        (from @BotFather)
//   TELEGRAM_WEBHOOK_SECRET   (any random string — optional but recommended)
//   OPENAI_API_KEY            (for _parse.js)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (already set for webhook.js)
// ─────────────────────────────────────────────────────
import {
  db, CATS, SYM, fmt, getUserByChatId, consumeLinkCode, hasBotAccess,
  getBotSettings, logExpense, getNetWorthSnapshot, goalNudge, checkBudgetAlert,
} from './_lib.js';
import { parseExpenseText, parseReceiptImage, transcribeAudio } from './_parse.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

const START_MSG =
`👋 *Welcome to FiniQ Bot!*

I log expenses straight into your FiniQ dashboard from a text, voice note, or receipt photo.

*Step 1:* Open FiniQ → 🤖 Bot tab → "Connect Bot" → copy your code
*Step 2:* Send me: /link 123456

Once linked, just send things like:
"₹450 lunch at Zomato"
"saved 100 EUR"
"sent 200 GBP home"
...or a voice note, or a photo of a receipt.

*Commands*
/networth — total net worth
/goals — savings goals progress
/currency EUR — set your display currency
/help — show this message`;

async function tgSend(chatId, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

async function tgFileUrl(fileId) {
  const r = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
  const data = await r.json();
  return `https://api.telegram.org/file/bot${TOKEN}/${data.result.file_path}`;
}

async function downloadBuffer(url) {
  const r = await fetch(url);
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req, res) {
  try {
    if (process.env.TELEGRAM_WEBHOOK_SECRET &&
        req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(401).end();
    }

    const msg = req.body && req.body.message;
    if (!msg) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    // ── Commands that don't need a linked account ──
    if (text === '/start' || text === '/help') {
      await tgSend(chatId, START_MSG);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/link')) {
      const code = (text.split(/\s+/)[1] || '').toUpperCase();
      if (!code) {
        await tgSend(chatId, 'Usage: `/link 123456` — get this code from FiniQ Dashboard → 🤖 Bot tab.');
      } else {
        const uid = await consumeLinkCode(code, 'telegram', chatId);
        await tgSend(chatId, uid
          ? '✅ Linked! Send me expenses anytime — text, voice note, or a receipt photo.'
          : '❌ Invalid or expired code. Generate a new one from the FiniQ dashboard.');
      }
      return res.status(200).json({ ok: true });
    }

    // ── Everything below needs a linked + Premium account ──
    const userId = await getUserByChatId('telegram', chatId);
    if (!userId) {
      await tgSend(chatId, "You're not linked yet. Send /start to get set up.");
      return res.status(200).json({ ok: true });
    }
    const access = await hasBotAccess(userId);
    if (!access.access) {
      await tgSend(chatId, access.reason === 'trial_expired'
        ? '⏰ Your 14-day free FiniQ trial has ended, so FiniQ Bot is now a Premium feature. Upgrade at https://getfiniq.app/dashboard.html to keep logging expenses by chat.'
        : '🔒 FiniQ Bot is a Premium feature. Upgrade at https://getfiniq.app/dashboard.html to unlock chat-based expense logging.');
      return res.status(200).json({ ok: true });
    }
    // Gentle reminder near the end of the trial (Premium users won't see this)
    const trialNote = (access.reason === 'trial' && access.trialDaysLeft <= 3)
      ? `\n\n🎁 ${access.trialDaysLeft} day${access.trialDaysLeft === 1 ? '' : 's'} left in your free trial — upgrade at https://getfiniq.app/dashboard.html to keep FiniQ Bot.`
      : '';

    const settings = await getBotSettings(userId);

    if (text.startsWith('/networth')) {
      const snap = await getNetWorthSnapshot(userId);
      await tgSend(chatId,
        `💎 *Total Net Worth*: ${snap.sym}${fmt(snap.netWorth)}\n` +
        `🎯 Saved toward goals: ${snap.sym}${fmt(snap.goalsTotal)}\n` +
        `📈 Saved & invested: ${snap.sym}${fmt(snap.savingsTotal)}`);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/goals')) {
      const snap = await getNetWorthSnapshot(userId);
      if (!snap.goals.length) {
        await tgSend(chatId, 'No goals yet — add one in FiniQ → Goals & Insights tab.');
      } else {
        const lines = snap.goals.map(g => {
          const pct = Math.min(100, Math.round((Number(g.current) / Number(g.target)) * 100));
          const s = SYM[g.currency] || g.currency;
          return `${g.emoji || '🎯'} ${g.name}: ${pct}% (${s}${fmt(g.current)} / ${s}${fmt(g.target)})`;
        });
        await tgSend(chatId, lines.join('\n'));
      }
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith('/currency')) {
      const code = (text.split(/\s+/)[1] || '').toUpperCase();
      if (!SYM[code]) {
        await tgSend(chatId, 'Supported currencies: ' + Object.keys(SYM).join(', '));
      } else {
        await db.from('bot_settings').upsert({ user_id: userId, home_currency: code }, { onConflict: 'user_id' });
        await tgSend(chatId, `✅ Display currency set to ${code}`);
      }
      return res.status(200).json({ ok: true });
    }

    // ── Parse the actual expense (text / voice / photo) ──
    let parsed;
    if (msg.voice || msg.audio) {
      const url = await tgFileUrl((msg.voice || msg.audio).file_id);
      const buf = await downloadBuffer(url);
      const transcript = await transcribeAudio(buf, 'voice.ogg');
      parsed = await parseExpenseText(transcript, settings.home_currency);
    } else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      const url = await tgFileUrl(largest.file_id);
      const buf = await downloadBuffer(url);
      const b64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
      parsed = await parseReceiptImage(b64, settings.home_currency, msg.caption || '');
    } else if (text) {
      parsed = await parseExpenseText(text, settings.home_currency);
    } else {
      await tgSend(chatId, 'Send me an expense as text, a voice note, or a receipt photo 🙂');
      return res.status(200).json({ ok: true });
    }

    if (!parsed || parsed.error || !parsed.amount) {
      await tgSend(chatId, "Couldn't find an amount in that. Try e.g. \"€12 lunch\" or \"saved 100 EUR\".");
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

    await tgSend(chatId, reply + trialNote);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Telegram bot error:', err);
    return res.status(200).json({ ok: true }); // 200 always, so Telegram doesn't retry-storm
  }
}

// ─────────────────────────────────────────────────────
// UPLOAD AS: api/bot/_parse.js
// AI parsing engine — turns text / voice / receipt photos into a
// structured expense object. Uses OpenAI (gpt-4o-mini text+vision,
// whisper-1 for voice) so ONE API key covers all three input types.
//
// REQUIRES VERCEL ENV VAR:  OPENAI_API_KEY
// ─────────────────────────────────────────────────────
import { CATS } from './_lib.js';

const CAT_LIST = CATS.map(c => `${c.id} = ${c.label}`).join('\n');

const SYSTEM_PROMPT = `You are an expense-logging assistant for the FiniQ finance app.
Extract a SINGLE financial transaction from the user's message (which may be in any
language or mix Hindi/English etc). Respond with ONLY compact JSON, no prose:

{
  "amount": <number, absolute value>,
  "currency": <3-letter ISO code, e.g. EUR, USD, INR, AED, GBP — guess from symbols/words/context if not stated, default "${'{{HOME}}'}">,
  "category": <one of: ${CATS.map(c=>c.id).join(', ')}>,
  "type": <"expense" | "income" | "savings">,
  "note": <short description, e.g. "Lunch at Zomato">,
  "date": <YYYY-MM-DD, default today (${'{{TODAY}}'}) if not mentioned>
}

Category reference:
${CAT_LIST}

If the message mentions saving/investing money, use category "savings" and type "savings".
If the message mentions sending money to family/home country, use category "remittance".
If you truly cannot find an amount, return {"error": "no_amount"}.`;

async function openaiChat(messages, { vision } = {}) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: vision ? 'gpt-4o-mini' : 'gpt-4o-mini',
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI error');
  return JSON.parse(data.choices[0].message.content);
}

// Transcribe a voice note (Buffer) -> text, via Whisper
export async function transcribeAudio(buffer, filename = 'voice.ogg') {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Whisper error');
  return data.text;
}

function buildPrompt(homeCurrency) {
  return SYSTEM_PROMPT
    .replace('{{HOME}}', homeCurrency || 'EUR')
    .replace('{{TODAY}}', new Date().toISOString().slice(0,10));
}

// Parse plain text, e.g. "₹450 lunch at Zomato" / "saved 100 euros"
export async function parseExpenseText(text, homeCurrency) {
  return openaiChat([
    { role: 'system', content: buildPrompt(homeCurrency) },
    { role: 'user', content: text },
  ]);
}

// Parse a receipt photo (image URL must be publicly fetchable, e.g. a
// short-lived Telegram/WhatsApp media URL)
export async function parseReceiptImage(imageUrl, homeCurrency, captionText = '') {
  return openaiChat([
    { role: 'system', content: buildPrompt(homeCurrency) },
    {
      role: 'user',
      content: [
        { type: 'text', text: captionText
            ? `Caption: ${captionText}\nExtract the transaction from this receipt photo.`
            : 'Extract the transaction from this receipt photo (use the TOTAL amount).' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ], { vision: true });
}

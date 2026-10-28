// Waynox Freight — static site + /api/lead -> Telegram bot.
// Zero dependencies (Node 18+). Secrets come from env vars, never from the browser:
//   TELEGRAM_BOT_TOKEN  — token from @BotFather
//   TELEGRAM_CHAT_ID    — chat/group/channel id(s); comma-separated for several recipients
//   TELEGRAM_JOIN_CODE  — optional access code; anyone who sends "/start <code>" to the bot also gets leads
const http = require('http');
const fs = require('fs');
const path = require('path');

// Minimal .env loader for local development (Render uses real env vars).
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');

// ---- Lead formatting -------------------------------------------------------
const TYPES = {
  callback: { title: '📞 Call-back request (Home)', fields: { name: 'Name', phone: 'Phone', email: 'Email', position: 'Position', exp: 'CDL-A experience', equip: 'Equipment', contact: 'Preferred contact', consent: 'SMS/call consent' } },
  application: { title: '🚛 Driver application (Join Our Team)', fields: { name: 'Name', phone: 'Phone', email: 'Email', city: 'City / State', exp: 'CDL-A experience', cdlState: 'CDL-A state', equip: 'Equipment', truck: 'Truck', start: 'Can start', lang: 'Language', contact: 'Preferred contact', notes: 'Notes', consent: 'SMS/call consent' } },
  drive: { title: '🚛 Driver application (Drive With Us)', fields: { name: 'Name', phone: 'Phone', email: 'Email', city: 'City / State', position: 'Position', exp: 'CDL-A experience', equip: 'Equipment', truck: 'Truck', start: 'Can start', lang: 'Language', contact: 'Preferred contact', notes: 'Notes', consent: 'SMS/call consent' } },
  contact: { title: '✉️ Contact message', fields: { role: 'I am a', name: 'Name', email: 'Email', phone: 'Phone', message: 'Message' } }
};
const REQUIRED = { callback: ['name', 'phone'], application: ['name', 'phone'], drive: ['name', 'phone'], contact: ['name', 'email', 'message'] };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (v) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, 1500) : '');

function buildMessage(type, fields, page) {
  const def = TYPES[type];
  const lines = [`<b>${def.title}</b>`, ''];
  for (const [key, label] of Object.entries(def.fields)) {
    const val = clean(fields[key]);
    if (val) lines.push(`<b>${esc(label)}:</b> ${esc(val)}`);
  }
  lines.push('', `<i>${esc(String(page || '').slice(0, 100))} · ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC</i>`);
  return lines.join('\n').slice(0, 4000);
}

// ---- Telegram --------------------------------------------------------------
// Leads go to every chat in TELEGRAM_CHAT_ID plus everyone who joined the bot with
// the access code (TELEGRAM_JOIN_CODE): "/start <code>" subscribes, "/stop" unsubscribes.
// Joined chats are saved to data/recipients.json and mirrored into a message the bot
// pins in the first TELEGRAM_CHAT_ID chat, so the list survives restarts on hosts
// with a wiped disk (Render free plan).
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FIXED_CHATS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
const JOIN_CODE = (process.env.TELEGRAM_JOIN_CODE || '').trim();
const STORE_FILE = path.join(__dirname, 'data', 'recipients.json');
const PIN_TAG = '#waynox-recipients';
const joined = new Map(); // chat id -> display name
let pinId = null;

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok && method !== 'getUpdates') console.error(`Telegram ${method} error`, r.status, data.description || '');
  return data;
}

async function loadRecipients() {
  try { for (const [id, name] of JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))) joined.set(String(id), name); } catch {}
  if (!FIXED_CHATS[0]) return;
  const pinned = (await tg('getChat', { chat_id: FIXED_CHATS[0] })).result?.pinned_message;
  const m = pinned?.text?.match(new RegExp(`${PIN_TAG}\\s*(\\[[\\s\\S]*\\])`));
  if (!m) return;
  pinId = pinned.message_id;
  try { for (const [id, name] of JSON.parse(m[1])) if (!joined.has(String(id))) joined.set(String(id), name); } catch {}
}

async function saveRecipients() {
  const list = [...joined];
  try { fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true }); fs.writeFileSync(STORE_FILE, JSON.stringify(list)); } catch (e) { console.error('Recipients file:', e.message); }
  if (!FIXED_CHATS[0]) return;
  const text = `📌 Website lead recipients (managed by the bot, keep pinned)\n${PIN_TAG} ${JSON.stringify(list)}`;
  if (pinId && (await tg('editMessageText', { chat_id: FIXED_CHATS[0], message_id: pinId, text })).ok) return;
  const sent = await tg('sendMessage', { chat_id: FIXED_CHATS[0], text, disable_notification: true });
  if (sent.ok) { pinId = sent.result.message_id; await tg('pinChatMessage', { chat_id: FIXED_CHATS[0], message_id: pinId, disable_notification: true }); }
}

async function handleBotMessage(msg) {
  if (!msg?.text || msg.chat?.type !== 'private') return;
  const id = String(msg.chat.id);
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') + (msg.from?.username ? ` (@${msg.from.username})` : '');
  const text = msg.text.trim();
  const reply = (t) => tg('sendMessage', { chat_id: id, text: t });
  if (/^\/stop\b/.test(text)) {
    if (joined.delete(id)) await saveRecipients();
    return reply('You will no longer receive website leads.');
  }
  const code = text.replace(/^\/start(@\w+)?\s*/, '').trim();
  if (code && code === JOIN_CODE) {
    if (!joined.has(id)) { joined.set(id, name); await saveRecipients(); console.log('Lead recipient joined:', name); }
    return reply('✅ Connected. New website applications and messages will arrive here. Send /stop to unsubscribe.');
  }
  if (FIXED_CHATS.includes(id) || joined.has(id)) return reply('You are already receiving website leads. Send /stop to unsubscribe.');
  return reply('Send the access code to receive Waynox website leads.');
}

async function pollBot() {
  await tg('deleteWebhook', { drop_pending_updates: false });
  let offset = 0;
  for (;;) {
    try {
      const data = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      if (!data.ok) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      for (const u of data.result) { offset = u.update_id + 1; await handleBotMessage(u.message).catch((e) => console.error('Bot message:', e.message)); }
    } catch (e) {
      console.error('Bot polling:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function sendToTelegram(text) {
  const chats = [...new Set([...FIXED_CHATS, ...joined.keys()])];
  if (!TOKEN || !chats.length) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured');
  const results = await Promise.all(chats.map(async (chat_id) => {
    const r = await tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
    // Drop joined users who blocked the bot or deleted their account.
    if (!r.ok && r.error_code === 403 && joined.delete(chat_id)) saveRecipients().catch(() => {});
    return !!r.ok;
  }));
  if (!results.some(Boolean)) throw new Error('Telegram rejected the message');
}

// ---- Simple in-memory rate limit (per IP) ----------------------------------
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 8;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < win)) hits.delete(k);
  return arr.length > max;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handleLead(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return json(res, 429, { ok: false, error: 'Too many requests' });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 20000) return json(res, 413, { ok: false, error: 'Too large' }); }
  let data;
  try { data = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'Bad JSON' }); }
  const { type, fields, page } = data || {};
  if (!TYPES[type] || !fields || typeof fields !== 'object') return json(res, 400, { ok: false, error: 'Bad request' });
  if (REQUIRED[type].some((k) => !clean(fields[k]))) return json(res, 400, { ok: false, error: 'Missing fields' });
  try {
    await sendToTelegram(buildMessage(type, fields, page));
    json(res, 200, { ok: true });
  } catch (e) {
    console.error('Lead failed:', e.message);
    json(res, 502, { ok: false, error: 'Delivery failed' });
  }
}

// ---- Static files ----------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json' };

// Clean page URLs (/about) map to the page files; the old /About.dc.html URLs redirect there.
const PAGES = { about: 'About', services: 'Services', safety: 'Safety', contact: 'Contact', faq: 'FAQ', legal: 'Legal', 'drive-with-us': 'Drive-With-Us', 'request-quote': 'Request-Quote' };
const PAGE_SLUGS = Object.fromEntries(Object.entries(PAGES).map(([slug, name]) => [`/${name}.dc.html`, `/${slug}`]));
Object.assign(PAGE_SLUGS, { '/index.html': '/', '/Home.dc.html': '/', '/Home': '/' });

function serveStatic(req, res) {
  let rel, url;
  try { url = new URL(req.url, 'http://x'); rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (PAGE_SLUGS[rel]) { res.writeHead(301, { Location: PAGE_SLUGS[rel] + url.search }); return res.end(); }
  const slug = rel.replace(/\/+$/, '').slice(1).toLowerCase();
  // Pages use relative asset paths, so /about/ or /About must redirect to the exact /about.
  if (PAGES[slug] && rel !== `/${slug}`) { res.writeHead(301, { Location: `/${slug}` + url.search }); return res.end(); }
  if (rel === '/') rel = '/index.html';
  else if (PAGES[slug]) rel = `/${PAGES[slug]}.dc.html`;
  const file = path.normalize(path.join(ROOT, rel));
  const parts = path.relative(ROOT, file).split(path.sep);
  const ext = path.extname(file).toLowerCase();
  if (file.indexOf(ROOT) !== 0 || parts.some((p) => p.startsWith('.')) || !MIME[ext]) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'X-Content-Type-Options': 'nosniff',
      // Header/footer components must stay crawlable (Google renders them into pages) but never rank on their own.
      ...(ext === '.html' && rel.endsWith('.dc.html') && !Object.values(PAGES).includes(path.basename(rel, '.dc.html')) ? { 'X-Robots-Tag': 'noindex' } : {}),
      'Cache-Control': ext === '.html' ? 'public, max-age=0, must-revalidate' : parts[0] === 'assets' ? 'public, max-age=86400' : 'public, max-age=300'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/api/lead') {
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    return handleLead(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
}).listen(PORT, () => console.log(`Waynox site on http://localhost:${PORT}`));

if (TOKEN) {
  loadRecipients()
    .then(() => { console.log(`Lead recipients: ${FIXED_CHATS.length} fixed + ${joined.size} joined`); if (JOIN_CODE) pollBot(); })
    .catch((e) => console.error('Telegram startup:', e.message));
}

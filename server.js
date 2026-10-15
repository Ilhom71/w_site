// Waynox Freight — static site + /api/lead -> Telegram bot.
// Zero dependencies (Node 18+). Secrets come from env vars, never from the browser:
//   TELEGRAM_BOT_TOKEN  — token from @BotFather
//   TELEGRAM_CHAT_ID    — chat/group/channel id(s); comma-separated for several recipients
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
  callback: { title: '📞 Call-back request (Home)', fields: { name: 'Name', phone: 'Phone', email: 'Email', exp: 'CDL-A experience', equip: 'Equipment', contact: 'Preferred contact', consent: 'SMS/call consent' } },
  application: { title: '🚛 Driver application (Join Our Team)', fields: { name: 'Name', phone: 'Phone', email: 'Email', city: 'City / State', exp: 'CDL-A experience', cdlState: 'CDL-A state', equip: 'Equipment', truck: 'Truck', start: 'Can start', lang: 'Language', contact: 'Preferred contact', notes: 'Notes', consent: 'SMS/call consent' } },
  drive: { title: '🚛 Driver application (Drive With Us)', fields: { name: 'Name', phone: 'Phone', email: 'Email', city: 'City / State', exp: 'CDL-A experience', equip: 'Equipment', truck: 'Truck', start: 'Can start', lang: 'Language', contact: 'Preferred contact', notes: 'Notes', consent: 'SMS/call consent' } },
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

async function sendToTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = (process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || !chats.length) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured');
  const results = await Promise.all(chats.map(async (chat_id) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    if (!r.ok) console.error('Telegram error', r.status, (await r.text()).replace(token, '***'));
    return r.ok;
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/' || rel === '/Home') rel = '/index.html';
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

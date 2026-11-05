'use strict';
/* Складской учёт закупок: сервер.
   Node.js + Express + SQLite. Данные лежат в одном файле data/sklad.db. */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SESSION_DAYS = +process.env.SESSION_DAYS || 30;
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const AI_MODEL_QUICK = process.env.AI_MODEL_QUICK || 'claude-haiku-5-5';
/* провайдер ИИ: anthropic (Claude) или yandex (Vision OCR + YandexGPT / Alice AI) */
const AI_PROVIDER = (process.env.AI_PROVIDER || 'anthropic').trim().toLowerCase() === 'yandex' ? 'yandex' : 'anthropic';
const YA_KEY = process.env.YANDEX_API_KEY || '';
const YA_FOLDER = process.env.YANDEX_FOLDER_ID || '';
const YA_BASE = (process.env.YANDEX_BASE_URL || 'https://ai.api.cloud.yandex.net').replace(/\/+$/, '');
const YA_MODEL = process.env.YANDEX_MODEL || 'yandexgpt/latest';
const YA_OCR_MODEL = process.env.YANDEX_OCR_MODEL || 'markdown';
const AI_ON = AI_PROVIDER === 'yandex' ? !!(YA_KEY && YA_FOLDER) : !!AI_KEY;
/* AI_LOG=1: полные ответы ИИ пишутся в data/ai-log (последние 100 файлов), чтобы разбирать качество распознавания */
const AI_LOG = /^(1|true|yes)$/i.test(process.env.AI_LOG || '');
const AI_LOG_DIR = path.join(DATA_DIR, 'ai-log');
const COLLECTIONS = new Set(['items', 'projects', 'receipts', 'moves', 'inventories', 'drafts']);
const ROLES = new Set(['admin', 'staff', 'viewer']);

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'sklad.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (col, id));
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
`);

/* ---------- пароли и сессии ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function createUser(login, password, role, name) {
  login = String(login || '').trim().toLowerCase();
  if (!/^[a-z0-9._@-]{2,40}$/.test(login)) throw new Error('Логин: 2–40 символов, латиница, цифры и . _ - @');
  if (String(password || '').length < 8) throw new Error('Пароль должен быть не короче 8 символов');
  if (!ROLES.has(role)) throw new Error('Неизвестная роль');
  db.prepare('INSERT INTO users(login,name,role,hash,created) VALUES (?,?,?,?,?)')
    .run(login, String(name || '').trim().slice(0, 80), role, hashPassword(password), Date.now());
}
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get() && process.env.ADMIN_LOGIN && process.env.ADMIN_PASSWORD) {
  try {
    createUser(process.env.ADMIN_LOGIN, process.env.ADMIN_PASSWORD, 'admin', process.env.ADMIN_NAME || 'Администратор');
    console.log('Создан администратор', process.env.ADMIN_LOGIN);
  } catch (e) {
    console.error('Не удалось создать администратора из настроек .env: ' + e.message);
    process.exit(1);
  }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600e3).unref();

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function userFromReq(req) {
  const t = parseCookies(req).sid;
  if (!t) return null;
  return db.prepare(`SELECT u.id,u.login,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?`)
    .get(sha(t), Date.now()) || null;
}

/* ---------- приложение ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
});

/* защита от подделки запросов: изменяющие запросы только со своим заголовком */
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'sklad') {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

const jsonSmall = express.json({ limit: '1mb' });
const jsonBig = express.json({ limit: '60mb' });

/* вход: не больше 10 неудачных попыток с одного адреса за 10 минут */
const fails = new Map();
function tooMany(ip) {
  const now = Date.now(), a = (fails.get(ip) || []).filter((t) => now - t < 600e3);
  fails.set(ip, a);
  return a.length >= 10;
}
app.post('/api/login', jsonSmall, (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Слишком много попыток. Подождите 10 минут.' });
  const { login, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE login=?').get(String(login || '').trim().toLowerCase());
  if (!u || !checkPassword(String(password || ''), u.hash)) {
    fails.get(ip).push(Date.now());
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES (?,?,?)').run(sha(token), u.id, Date.now() + SESSION_DAYS * 86400e3);
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const t = parseCookies(req).sid;
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(sha(t));
  res.set('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

/* всё остальное в /api только для вошедших */
app.use('/api', (req, res, next) => {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'auth' });
  req.user = u;
  next();
});
const canWrite = (req, res, next) => (req.user.role === 'viewer' ? res.status(403).json({ error: 'Только просмотр' }) : next());
const adminOnly = (req, res, next) => (req.user.role !== 'admin' ? res.status(403).json({ error: 'Только для администратора' }) : next());

app.get('/api/me', (req, res) => res.json({ login: req.user.login, name: req.user.name || req.user.login, role: req.user.role, ai: AI_ON ? AI_PROVIDER : false }));

/* ---------- документы ---------- */
const idOk = (s) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
const colOk = (req, res, next) => (COLLECTIONS.has(req.params.col) ? next() : res.status(404).json({ error: 'unknown collection' }));

const clients = new Set();
function broadcast(col) {
  for (const c of clients) c.write(`data: ${JSON.stringify({ c: col })}\n\n`);
}
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const hb = setInterval(() => res.write(': hb\n\n'), 25000);
  res.on('close', () => { clearInterval(hb); clients.delete(res); });
});

app.get('/api/c/:col', colOk, (req, res) => {
  const rows = db.prepare('SELECT id,data FROM docs WHERE col=?').all(req.params.col);
  res.json(rows.map((r) => ({ id: r.id, data: JSON.parse(r.data) })));
});
function putDoc(col, id, data) {
  db.prepare('INSERT INTO docs(col,id,data,updated) VALUES (?,?,?,?) ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, updated=excluded.updated')
    .run(col, id, JSON.stringify(data), Date.now());
}
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
/* товары меняет только администратор; сотрудник при приходе может создать новый товар,
   дописать группу и названия из документов поставщика, а также писать комментарий к позиции */
const ITEM_STAFF_FIELDS = new Set(['group', 'aliases', 'note']);
const itemDenied = (req) => req.params.col === 'items' && req.user.role !== 'admin';
app.put('/api/c/:col/:id', canWrite, colOk, jsonSmall, (req, res) => {
  if (!idOk(req.params.id) || !isObj(req.body)) return res.status(400).json({ error: 'bad request' });
  if (itemDenied(req) && db.prepare('SELECT 1 FROM docs WHERE col=? AND id=?').get('items', req.params.id)) return res.status(403).json({ error: 'Менять товары может только администратор' });
  putDoc(req.params.col, req.params.id, req.body);
  broadcast(req.params.col);
  res.json({ ok: true });
});
app.patch('/api/c/:col/:id', canWrite, colOk, jsonSmall, (req, res) => {
  if (!idOk(req.params.id) || !isObj(req.body)) return res.status(400).json({ error: 'bad request' });
  if (itemDenied(req) && Object.keys(req.body).some((k) => !ITEM_STAFF_FIELDS.has(k))) return res.status(403).json({ error: 'Менять товары может только администратор' });
  const row = db.prepare('SELECT data FROM docs WHERE col=? AND id=?').get(req.params.col, req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  putDoc(req.params.col, req.params.id, Object.assign(JSON.parse(row.data), req.body));
  broadcast(req.params.col);
  res.json({ ok: true });
});
app.delete('/api/c/:col/:id', canWrite, colOk, (req, res) => {
  if (itemDenied(req)) return res.status(403).json({ error: 'Удалять товары может только администратор' });
  db.prepare('DELETE FROM docs WHERE col=? AND id=?').run(req.params.col, req.params.id);
  broadcast(req.params.col);
  res.json({ ok: true });
});

/* ---------- распознавание: прокси к Claude API или к Яндексу ---------- */
function aiLog(kind, data) {
  const short = JSON.stringify(data).slice(0, 600);
  console.log(`[ИИ ${kind}] ${short}`);
  if (!AI_LOG) return;
  try {
    fs.mkdirSync(AI_LOG_DIR, { recursive: true });
    const d = new Date(), stamp = d.toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(AI_LOG_DIR, `${stamp}-${kind}.json`), JSON.stringify(data, null, 2));
    const files = fs.readdirSync(AI_LOG_DIR).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 100))) fs.unlinkSync(path.join(AI_LOG_DIR, f));
  } catch (e) {
    console.error('Не удалось записать журнал ИИ: ' + e.message);
  }
}
const apiMsg = (status, name) => status === 401 ? `Неверный ключ ${name}` : status === 429 ? `Лимит запросов ${name}, повторите позже`
  : status === 403 ? `${name} недоступен из этого региона или для этого ключа (проверьте права ключа и каталог)` : `Ошибка ${name} (${status})`;
class ApiError extends Error {}

async function claudeCall(prompt, imgs, quick, signal) {
  const content = imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }));
  content.push({ type: 'text', text: prompt });
  const r = await fetch(AI_BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: quick ? AI_MODEL_QUICK : AI_MODEL, max_tokens: quick ? 30 : 16000, messages: [{ role: 'user', content }] }),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Claude API', r.status, JSON.stringify(j).slice(0, 500));
    throw new ApiError(apiMsg(r.status, 'API Claude'));
  }
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, truncated: j.stop_reason === 'max_tokens' };
}

const yaHeaders = () => ({ Authorization: 'Api-Key ' + YA_KEY, 'x-folder-id': YA_FOLDER, 'OpenAI-Project': YA_FOLDER, 'content-type': 'application/json' });
async function yandexChat(prompt, quick, signal) {
  const model = YA_MODEL.startsWith('gpt://') ? YA_MODEL : `gpt://${YA_FOLDER}/${YA_MODEL}`;
  const body = { model, messages: [{ role: 'user', content: prompt }], max_tokens: quick ? 30 : 8000, temperature: 0.1 };
  const t0 = Date.now();
  const r = await fetch(YA_BASE + '/v1/chat/completions', { method: 'POST', headers: yaHeaders(), body: JSON.stringify(body), signal });
  const j = await r.json().catch(() => ({}));
  aiLog('yandex-llm', { status: r.status, ms: Date.now() - t0, model, promptChars: prompt.length, response: j });
  if (!r.ok) throw new ApiError(apiMsg(r.status, 'YandexGPT'));
  const ch = (j.choices || [])[0] || {};
  return { text: (ch.message && ch.message.content) || '', truncated: ch.finish_reason === 'length' };
}

/* текст таблиц из ответа OCR: строки через перевод строки, ячейки через « | » */
function ocrTables(tables) {
  return (tables || []).map((t) => {
    const rows = [];
    for (const c of t.cells || []) {
      const ri = +c.rowIndex || 0, ci = +c.columnIndex || 0;
      (rows[ri] = rows[ri] || [])[ci] = String(c.text || '').replace(/\s+/g, ' ').trim();
    }
    return rows.filter(Boolean).map((r) => Array.from(r, (x) => x || '').join(' | ')).join('\n');
  }).filter(Boolean);
}
async function yandexOcr(img, signal) {
  const mimeType = img.media_type === 'image/png' ? 'PNG' : 'JPEG';
  const t0 = Date.now();
  const r = await fetch(YA_BASE + '/ocr/v1/recognizeText', {
    method: 'POST', headers: yaHeaders(), signal,
    body: JSON.stringify({ mimeType, languageCodes: ['ru', 'en'], model: YA_OCR_MODEL, content: img.data }),
  });
  const j = await r.json().catch(() => ({}));
  const a = (j.result && j.result.textAnnotation) || j.textAnnotation || {};
  aiLog('yandex-ocr', {
    status: r.status, ms: Date.now() - t0, model: YA_OCR_MODEL, bytes: Math.round(img.data.length * 0.75),
    rotate: a.rotate, width: a.width, height: a.height, blocks: (a.blocks || []).length, tables: (a.tables || []).length,
    markdownChars: (a.markdown || '').length, fullTextChars: (a.fullText || '').length, response: r.ok ? a : j,
  });
  if (!r.ok) throw new ApiError(apiMsg(r.status, 'Yandex Vision OCR'));
  const tables = a.markdown ? [] : ocrTables(a.tables);
  const text = a.markdown || [a.fullText || '', ...tables.map((t, k) => `Таблица ${k + 1}:\n${t}`)].join('\n\n');
  const rot = { ANGLE_90: 90, ANGLE_180: 180, ANGLE_270: 270 }[a.rotate] || 0;
  return { text: text.trim(), rotate: rot };
}

const aiBusy = new Map();
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
/* общая обвязка: не больше 2 запросов к ИИ одновременно от пользователя, отмена при закрытии вкладки */
function aiRoute(handler) {
  return async (req, res) => {
    if (!AI_ON) {
      return res.status(503).json({ error: AI_PROVIDER === 'yandex' ? 'Распознавание не настроено: в .env не указаны YANDEX_API_KEY и YANDEX_FOLDER_ID' : 'Распознавание не настроено: в .env не указан ANTHROPIC_API_KEY' });
    }
    if ((aiBusy.get(req.user.id) || 0) >= 2) return res.status(429).json({ error: 'Подождите, предыдущий документ ещё разбирается.' });
    aiBusy.set(req.user.id, (aiBusy.get(req.user.id) || 0) + 1);
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
    try {
      res.json(await handler(req, AbortSignal.any([ctrl.signal, AbortSignal.timeout(280000)])));
    } catch (e) {
      const known = e instanceof ApiError || e.status === 400;
      if (!res.headersSent) res.status(e.status === 400 ? 400 : 502).json({ error: known ? e.message : 'Не удалось связаться с API: ' + (e && e.message || e) });
    } finally {
      aiBusy.set(req.user.id, Math.max(0, (aiBusy.get(req.user.id) || 1) - 1));
    }
  };
}
const badReq = (m) => Object.assign(new Error(m), { status: 400 });

app.post('/api/ai', canWrite, jsonBig, aiRoute(async (req, signal) => {
  const { prompt, images, tier } = req.body || {};
  if (typeof prompt !== 'string' || !prompt || prompt.length > 250000) throw badReq('bad prompt');
  const imgs = Array.isArray(images) ? images.slice(0, 12) : [];
  for (const i of imgs) {
    if (!i || !IMG_TYPES.includes(i.media_type) || typeof i.data !== 'string') throw badReq('bad image');
  }
  if (AI_PROVIDER === 'yandex') {
    if (imgs.length) throw badReq('Для Яндекса изображения сначала распознаются через /api/ocr');
    return yandexChat(prompt, tier === 'quick', signal);
  }
  return claudeCall(prompt, imgs, tier === 'quick', signal);
}));

/* распознавание текста одной страницы (только для Яндекса): {image:{media_type,data}} → {text, rotate} */
app.post('/api/ocr', canWrite, jsonBig, aiRoute(async (req, signal) => {
  if (AI_PROVIDER !== 'yandex') throw badReq('OCR доступен только при AI_PROVIDER=yandex');
  const img = (req.body || {}).image;
  if (!img || !['image/jpeg', 'image/png'].includes(img.media_type) || typeof img.data !== 'string') throw badReq('bad image');
  if (img.data.length * 0.75 > 10e6) throw badReq('Страница больше 10 МБ, Vision OCR такую не примет');
  return yandexOcr(img, signal);
}));

/* ---------- пользователи и резервная копия (только администратор) ---------- */
app.get('/api/users', adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id,login,name,role,created FROM users ORDER BY login').all());
});
app.post('/api/users', adminOnly, jsonSmall, (req, res) => {
  try {
    createUser(req.body.login, req.body.password, req.body.role, req.body.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'Такой логин уже есть' : e.message });
  }
});
app.patch('/api/users/:id', adminOnly, jsonSmall, (req, res) => {
  const id = +req.params.id, u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (b.role !== undefined) {
    if (!ROLES.has(b.role)) return res.status(400).json({ error: 'Неизвестная роль' });
    if (u.role === 'admin' && b.role !== 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c <= 1) return res.status(400).json({ error: 'Нельзя убрать последнего администратора' });
    db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, id);
  }
  if (b.name !== undefined) db.prepare('UPDATE users SET name=? WHERE id=?').run(String(b.name).slice(0, 80), id);
  if (b.password) {
    if (String(b.password).length < 8) return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
    db.prepare('UPDATE users SET hash=? WHERE id=?').run(hashPassword(String(b.password)), id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  res.json({ ok: true });
});
app.delete('/api/users/:id', adminOnly, (req, res) => {
  const id = +req.params.id, u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  res.json({ ok: true });
});
app.get('/api/backup', adminOnly, async (req, res) => {
  const tmp = path.join(os.tmpdir(), 'sklad-backup-' + Date.now() + '.db');
  try {
    await db.backup(tmp);
    const d = new Date(), stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    res.download(tmp, `sklad-${stamp}.db`, () => fs.unlink(tmp, () => {}));
  } catch (e) {
    res.status(500).json({ error: 'Не удалось сделать копию' });
  }
});
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

/* ---------- страницы ---------- */
const PUB = path.join(__dirname, 'public');
app.get('/', (req, res) => {
  if (!userFromReq(req)) return res.redirect('/login.html');
  res.set('Cache-Control', 'no-store').sendFile(path.join(PUB, 'index.html'));
});
app.use(express.static(PUB, { index: false, maxAge: '1h' }));

app.listen(PORT, () => console.log(`Склад закупок: http://localhost:${PORT}  (распознавание: ${AI_ON ? AI_PROVIDER : 'выключено'}${AI_LOG ? ', журнал ИИ в ' + AI_LOG_DIR : ''})`));

module.exports = { createUser, db };

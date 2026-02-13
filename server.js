import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3007;
const HOST = process.env.HOST || '0.0.0.0';

const DATA_DIR = path.join(__dirname, 'data');
const HOLDINGS_PATH = path.join(DATA_DIR, 'holdings.json');
const FUNDS_CACHE_PATH = path.join(DATA_DIR, 'funds_cache.json');
const QUOTES_CACHE_PATH = path.join(DATA_DIR, 'quotes_cache.json');

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!fssync.existsSync(HOLDINGS_PATH)) {
    await fs.writeFile(HOLDINGS_PATH, JSON.stringify({ holdings: [], updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  }
  if (!fssync.existsSync(QUOTES_CACHE_PATH)) {
    await fs.writeFile(QUOTES_CACHE_PATH, JSON.stringify({ quotes: {}, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  }
}

async function readHoldings() {
  await ensureDataFiles();
  const raw = await fs.readFile(HOLDINGS_PATH, 'utf8');
  const json = JSON.parse(raw || '{}');
  return Array.isArray(json.holdings) ? json.holdings : [];
}

async function writeHoldings(holdings) {
  await ensureDataFiles();
  const payload = { holdings, updatedAt: new Date().toISOString() };
  await fs.writeFile(HOLDINGS_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

function safeJsonpToJson(text) {
  // fundgz returns: jsonpgz({ ... });
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) throw new Error('Unexpected JSONP format');
  const jsonStr = text.slice(start + 1, end);
  return JSON.parse(jsonStr);
}

async function readQuotesCache() {
  await ensureDataFiles();
  const raw = await fs.readFile(QUOTES_CACHE_PATH, 'utf8');
  const json = JSON.parse(raw || '{}');
  return json?.quotes && typeof json.quotes === 'object' ? json.quotes : {};
}

async function writeQuoteCache(code, quote) {
  const quotes = await readQuotesCache();
  quotes[String(code)] = {
    code: String(quote.code || code),
    name: String(quote.name || ''),
    date: String(quote.date || ''),
    todayPct: Number.isFinite(quote.todayPct) ? Number(quote.todayPct) : null,
    cachedAt: new Date().toISOString()
  };
  await fs.writeFile(QUOTES_CACHE_PATH, JSON.stringify({ quotes, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

async function fetchFundQuoteOnline(code) {
  const url = `https://fundgz.1234567.com.cn/js/${encodeURIComponent(code)}.js?rt=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://fund.eastmoney.com/'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`Quote fetch failed: ${res.status}`);
  const txt = await res.text();
  const data = safeJsonpToJson(txt);
  const pct = Number(data.gszzl);
  return {
    code: data.fundcode || code,
    name: data.name || '',
    date: data.gztime || data.jzrq || '',
    todayPct: Number.isFinite(pct) ? pct : null
  };
}

async function fetchFundQuote(code) {
  try {
    const online = await fetchFundQuoteOnline(code);
    await writeQuoteCache(code, online);
    return { ...online, source: 'live' };
  } catch (e) {
    const quotes = await readQuotesCache();
    const cached = quotes[String(code)];
    if (cached && cached.cachedAt) {
      const ageMs = Date.now() - new Date(cached.cachedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs < 24 * 3600 * 1000) {
        return { ...cached, source: 'cache', stale: true };
      }
    }
    throw e;
  }
}

async function loadFundListCached() {
  // Cache for fund code/name search.
  // Source: Eastmoney fundcode_search.js (var r = [[code,abbr,name,type,pinyin],...];)
  // We cache minimal fields.
  await ensureDataFiles();
  try {
    const stat = await fs.stat(FUNDS_CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 7 * 24 * 3600 * 1000) {
      const raw = await fs.readFile(FUNDS_CACHE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (_) {
    // ignore
  }

  const url = 'https://fund.eastmoney.com/js/fundcode_search.js';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Fund list fetch failed: ${res.status}`);
  const txt = await res.text();

  const idx = txt.indexOf('var r =');
  if (idx === -1) throw new Error('Unexpected fund list format');
  const start = txt.indexOf('[', idx);
  const end = txt.lastIndexOf('];');
  if (start === -1 || end === -1) throw new Error('Unexpected fund list format');
  const arrStr = txt.slice(start, end + 1);
  const arr = JSON.parse(arrStr);

  const list = arr
    .filter(x => Array.isArray(x) && x.length >= 3)
    .map(x => ({ code: String(x[0]), abbr: String(x[1] || ''), name: String(x[2] || ''), pinyin: String(x[4] || '') }));

  await fs.writeFile(FUNDS_CACHE_PATH, JSON.stringify(list, null, 2), 'utf8');
  return list;
}

function fuzzyMatch(q, item) {
  const qq = q.trim().toLowerCase();
  if (!qq) return false;
  return (
    item.code.includes(qq) ||
    item.name.toLowerCase().includes(qq) ||
    item.abbr.toLowerCase().includes(qq) ||
    item.pinyin.toLowerCase().includes(qq)
  );
}

// APIs
app.get('/api/holdings', async (req, res) => {
  const holdings = await readHoldings();
  res.json({ holdings });
});

app.post('/api/holdings', async (req, res) => {
  const { code, name, amount, holdingProfit } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  const amt = Number(amount);
  const hp = Number(holdingProfit);
  if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'amount invalid' });
  if (!Number.isFinite(hp)) return res.status(400).json({ error: 'holdingProfit invalid' });

  const holdings = await readHoldings();
  const now = new Date().toISOString();
  const idx = holdings.findIndex(h => h.code === String(code));
  const item = {
    code: String(code),
    name: String(name || ''),
    amount: amt,
    holdingProfit: hp,
    createdAt: idx === -1 ? now : holdings[idx].createdAt,
    updatedAt: now
  };
  if (idx === -1) holdings.unshift(item);
  else holdings[idx] = item;
  await writeHoldings(holdings);
  res.json({ ok: true, item });
});

app.delete('/api/holdings/:code', async (req, res) => {
  const code = String(req.params.code || '');
  const holdings = await readHoldings();
  const next = holdings.filter(h => h.code !== code);
  await writeHoldings(next);
  res.json({ ok: true });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ q, results: [] });
  try {
    const list = await loadFundListCached();
    const results = [];
    for (const item of list) {
      if (fuzzyMatch(q, item)) results.push(item);
      if (results.length >= 30) break;
    }
    res.json({ q, results });
  } catch (e) {
    res.status(503).json({ error: 'fund list unavailable', message: String(e?.message || e) });
  }
});

app.get('/api/quote/:code', async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const q = await fetchFundQuote(code);
    res.json(q);
  } catch (e) {
    res.status(503).json({ error: 'quote unavailable', message: '估值接口暂不可用，请稍后重试' });
  }
});

// Static frontend
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, HOST, async () => {
  await ensureDataFiles();
  console.log(`DuanFunds running at http://${HOST}:${PORT}`);
});

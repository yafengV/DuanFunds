import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3007;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'duanfunds-secret-key-change-in-production';

const DATA_DIR = path.join(__dirname, 'data');
const HOLDINGS_PATH = path.join(DATA_DIR, 'holdings.json');
const FUNDS_CACHE_PATH = path.join(DATA_DIR, 'funds_cache.json');
const QUOTES_CACHE_PATH = path.join(DATA_DIR, 'quotes_cache.json');
const USERS_PATH = path.join(DATA_DIR, 'users.json');

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!fssync.existsSync(HOLDINGS_PATH)) {
    await fs.writeFile(HOLDINGS_PATH, JSON.stringify({ holdings: [], updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  }
  if (!fssync.existsSync(QUOTES_CACHE_PATH)) {
    await fs.writeFile(QUOTES_CACHE_PATH, JSON.stringify({ quotes: {}, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  }
  if (!fssync.existsSync(USERS_PATH)) {
    await fs.writeFile(USERS_PATH, JSON.stringify({ users: [] }, null, 2), 'utf8');
  }
}

// User management functions
async function readUsers() {
  await ensureDataFiles();
  const raw = await fs.readFile(USERS_PATH, 'utf8');
  const json = JSON.parse(raw || '{}');
  return Array.isArray(json.users) ? json.users : [];
}

async function writeUsers(users) {
  await ensureDataFiles();
  await fs.writeFile(USERS_PATH, JSON.stringify({ users }, null, 2), 'utf8');
}

async function findUserByUsername(username) {
  const users = await readUsers();
  return users.find(u => u.username === username);
}

async function createUser(username, password, email = '') {
  const users = await readUsers();
  if (users.find(u => u.username === username)) {
    throw new Error('用户名已存在');
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: Date.now().toString(),
    username,
    email,
    password: hashedPassword,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  users.push(newUser);
  await writeUsers(users);
  return { id: newUser.id, username: newUser.username, email: newUser.email };
}

async function verifyUser(username, password) {
  const user = await findUserByUsername(username);
  if (!user) {
    throw new Error('用户不存在');
  }
  
  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    throw new Error('密码错误');
  }
  
  return { id: user.id, username: user.username, email: user.email };
}

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: '需要登录' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: '登录已过期，请重新登录' });
    }
    req.user = user;
    next();
  });
}

// Holdings functions (user-specific)
async function readUserHoldings(userId) {
  await ensureDataFiles();
  const raw = await fs.readFile(HOLDINGS_PATH, 'utf8');
  const json = JSON.parse(raw || '{}');
  
  // If it's the old format (global holdings), migrate to user-specific
  if (Array.isArray(json.holdings)) {
    // Migrate old data to first user (if exists)
    const users = await readUsers();
    if (users.length > 0) {
      const userHoldings = {
        [users[0].id]: json.holdings
      };
      await fs.writeFile(HOLDINGS_PATH, JSON.stringify({ userHoldings, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
      return userHoldings[userId] || [];
    }
    return [];
  }
  
  return json.userHoldings && json.userHoldings[userId] ? json.userHoldings[userId] : [];
}

async function writeUserHoldings(userId, holdings) {
  await ensureDataFiles();
  const raw = await fs.readFile(HOLDINGS_PATH, 'utf8');
  const json = JSON.parse(raw || '{}');
  
  let userHoldings = json.userHoldings || {};
  userHoldings[userId] = holdings;
  
  await fs.writeFile(HOLDINGS_PATH, JSON.stringify({ userHoldings, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

// Auth APIs
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码必填' });
    }
    
    if (username.length < 3) {
      return res.status(400).json({ error: '用户名至少3个字符' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少6个字符' });
    }
    
    const user = await createUser(username, password, email);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ 
      ok: true, 
      user: { id: user.id, username: user.username, email: user.email },
      token 
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码必填' });
    }
    
    const user = await verifyUser(username, password);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ 
      ok: true, 
      user: { id: user.id, username: user.username, email: user.email },
      token 
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// Holdings APIs (now user-specific)
app.get('/api/holdings', authenticateToken, async (req, res) => {
  const holdings = await readUserHoldings(req.user.id);
  res.json({ holdings });
});

app.post('/api/holdings', authenticateToken, async (req, res) => {
  const { code, name, amount, holdingProfit } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  const amt = Number(amount);
  const hp = Number(holdingProfit);

  if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'amount invalid' });
  if (!Number.isFinite(hp)) return res.status(400).json({ error: 'holdingProfit invalid' });

  const holdings = await readUserHoldings(req.user.id);
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
  await writeUserHoldings(req.user.id, holdings);
  res.json({ ok: true, item });
});

app.delete('/api/holdings/:code', authenticateToken, async (req, res) => {
  const code = String(req.params.code || '');
  const holdings = await readUserHoldings(req.user.id);
  const next = holdings.filter(h => h.code !== code);
  await writeUserHoldings(req.user.id, next);
  res.json({ ok: true });
});

// Public APIs (no auth required)
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

// Helper functions (keep existing)
function safeJsonpToJson(text) {
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

async function fetchFundQuoteViaFundMNewApi(code) {
  const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=1&appType=ttjj&product=EFund&plat=Android&Version=1&deviceid=openclaw&Fcodes=${encodeURIComponent(code)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://fund.eastmoney.com/'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`FundM API failed: ${res.status}`);
  const json = await res.json();
  const row = Array.isArray(json?.Datas) ? json.Datas[0] : null;
  if (!row) throw new Error('FundM API empty');
  const pct = Number(row.GSZZL);
  return {
    code: String(row.FCODE || code),
    name: String(row.SHORTNAME || ''),
    date: String(row.GZTIME || row.PDATE || ''),
    todayPct: Number.isFinite(pct) ? pct : null
  };
}

async function fetchFundQuoteViaFundgz(code) {
  const url = `https://fundgz.1234567.com.cn/js/${encodeURIComponent(code)}.js?rt=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://fund.eastmoney.com/'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`fundgz failed: ${res.status}`);
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

async function fetchFundQuoteOnline(code) {
  try {
    return await fetchFundQuoteViaFundMNewApi(code);
  } catch (_) {
    return await fetchFundQuoteViaFundgz(code);
  }
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

// Static frontend
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, HOST, async () => {
  await ensureDataFiles();
  console.log(`DuanFunds running at http://${HOST}:${PORT}`);
});
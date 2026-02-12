const viewEl = document.getElementById('view');
const navTitleEl = document.getElementById('navTitle');
const navRightBtnEl = document.getElementById('navRightBtn');
const footerHintEl = document.getElementById('footerHint');

function fmtMoney(n){
  if(!Number.isFinite(n)) return '--';
  return n.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}
function fmtPct(n){
  if(n === null || n === undefined) return '--';
  if(!Number.isFinite(n)) return '--';
  const s = n.toFixed(2) + '%';
  return s;
}
function clsBySign(n){
  if(!Number.isFinite(n)) return '';
  if(n > 0) return 'pos';
  if(n < 0) return 'neg';
  return '';
}

function toast(msg){
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>{ el.remove(); }, 2600);
}

async function apiGet(url){
  const res = await fetch(url);
  const data = await res.json().catch(()=> ({}));
  if(!res.ok) throw new Error(data?.message || data?.error || ('HTTP ' + res.status));
  return data;
}
async function apiJson(url, body, method='POST'){
  const res = await fetch(url, {method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  const data = await res.json().catch(()=> ({}));
  if(!res.ok) throw new Error(data?.message || data?.error || ('HTTP ' + res.status));
  return data;
}

function parseHash(){
  const h = location.hash || '#/';
  const [path, qs] = h.slice(1).split('?');
  const params = new URLSearchParams(qs || '');
  return { path: '/' + (path || '' ).replace(/^\//,'') , params };
}

function setNav({title, rightText, rightHref}){
  navTitleEl.textContent = title;
  if(rightText){
    navRightBtnEl.style.display = '';
    navRightBtnEl.textContent = rightText;
    navRightBtnEl.setAttribute('href', rightHref || '#/');
  }else{
    navRightBtnEl.style.display = 'none';
  }
}

async function loadHome(){
  setNav({title:'基金估值', rightText:'添加', rightHref:'#/search'});
  footerHintEl.textContent = '提示：名称列固定，其余列可左右滑动；接口异常会提示。';

  viewEl.innerHTML = `
    <div class="card">
      <div class="kpis">
        <div class="kpi">
          <div class="kpi__label">总持仓（元）</div>
          <div class="kpi__value" id="kpiTotal">--</div>
        </div>
        <div class="kpi">
          <div class="kpi__label">当日盈亏（元）</div>
          <div class="kpi__value" id="kpiToday">--</div>
        </div>
      </div>
      <div class="muted" style="margin-top:10px;font-size:12px" id="kpiTime"></div>
    </div>

    <div class="card">
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px">持仓列表</div>
      <div class="tableWrap">
        <div class="tableHeader">
          <div class="colName">
            <div class="cellName headerCell">名称</div>
          </div>
          <div class="scrollCols">
            <div class="colsInner">
              <div class="col"><div class="cell headerCell">持仓金额</div></div>
              <div class="col"><div class="cell headerCell">当日涨幅</div></div>
              <div class="col"><div class="cell headerCell">当日收益</div></div>
              <div class="col"><div class="cell headerCell">持仓涨幅</div></div>
              <div class="col"><div class="cell headerCell">持仓收益</div></div>
              <div class="col"><div class="cell headerCell">操作</div></div>
            </div>
          </div>
        </div>
        <div class="tableBody" id="tableBody"></div>
      </div>
      <div class="muted" style="margin-top:10px;font-size:12px">说明：持仓涨幅/收益来自“持有收益”录入；当日收益=持仓金额×当日涨幅。</div>
    </div>
  `;

  const kpiTotalEl = document.getElementById('kpiTotal');
  const kpiTodayEl = document.getElementById('kpiToday');
  const kpiTimeEl = document.getElementById('kpiTime');
  const tableBody = document.getElementById('tableBody');

  let holdings = [];
  try{
    const r = await apiGet('/api/holdings');
    holdings = r.holdings || [];
  }catch(e){
    toast('读取持仓失败：' + e.message);
  }

  if(!holdings.length){
    tableBody.innerHTML = `<div style="padding:12px" class="muted">暂无持仓，点击右上角“添加”。</div>`;
    kpiTotalEl.textContent = fmtMoney(0);
    kpiTodayEl.textContent = fmtMoney(0);
    kpiTimeEl.textContent = '';
    return;
  }

  // Fetch quotes in parallel (best-effort)
  const quotes = new Map();
  const times = [];
  await Promise.all(holdings.map(async h => {
    try{
      const q = await apiGet('/api/quote/' + encodeURIComponent(h.code));
      quotes.set(h.code, q);
      if(q.date) times.push(q.date);
    }catch(e){
      quotes.set(h.code, { code: h.code, name: h.name, todayPct: null, date: '' , error: e.message});
    }
  }));

  const rows = [];
  let totalAmt = 0;
  let totalToday = 0;

  for(const h of holdings){
    const q = quotes.get(h.code) || {};
    const todayPct = Number.isFinite(q.todayPct) ? q.todayPct : null;
    const amt = Number(h.amount) || 0;
    const hp = Number(h.holdingProfit) || 0;

    const todayProfit = todayPct === null ? null : (amt * todayPct / 100);
    const holdingPct = amt > 0 ? (hp / amt * 100) : 0;

    totalAmt += amt;
    if(todayProfit !== null) totalToday += todayProfit;

    rows.push({
      code: h.code,
      name: h.name || q.name || '',
      amt,
      todayPct,
      todayProfit,
      holdingPct,
      holdingProfit: hp,
      quoteDate: q.date || '',
      quoteError: q.error || ''
    });
  }

  kpiTotalEl.textContent = fmtMoney(totalAmt);
  kpiTodayEl.textContent = (Number.isFinite(totalToday) ? (totalToday >= 0 ? '+' : '') + fmtMoney(totalToday) : '--');
  kpiTodayEl.className = 'kpi__value ' + clsBySign(totalToday);

  const latestTime = times.sort().slice(-1)[0];
  kpiTimeEl.textContent = latestTime ? `估值时间：${latestTime}` : '估值时间：--（接口可能不可用）';

  tableBody.innerHTML = rows.map(r => {
    const todayPctTxt = r.todayPct === null ? '<span class="muted">--</span>' : `<span class="${clsBySign(r.todayPct)}">${fmtPct(r.todayPct)}</span>`;
    const todayProfitTxt = r.todayProfit === null ? '<span class="muted">--</span>' : `<span class="${clsBySign(r.todayProfit)}">${(r.todayProfit>=0?'+':'') + fmtMoney(r.todayProfit)}</span>`;
    const holdingPctTxt = `<span class="${clsBySign(r.holdingPct)}">${(r.holdingPct>=0?'+':'') + fmtPct(r.holdingPct)}</span>`;
    const holdingProfitTxt = `<span class="${clsBySign(r.holdingProfit)}">${(r.holdingProfit>=0?'+':'') + fmtMoney(r.holdingProfit)}</span>`;

    const err = r.quoteError ? `<div class="nameSub" style="color:var(--muted)">接口异常：${r.quoteError}</div>` : '';

    return `
      <div class="tr">
        <div class="colName">
          <div class="cellName">
            <div class="nameMain">${escapeHtml(r.name || '--')}</div>
            <div class="nameSub">${escapeHtml(r.code)}</div>
            ${err}
          </div>
        </div>
        <div class="scrollCols cellRowBg">
          <div class="colsInner">
            <div class="col"><div class="cell">${fmtMoney(r.amt)}</div></div>
            <div class="col"><div class="cell">${todayPctTxt}</div></div>
            <div class="col"><div class="cell">${todayProfitTxt}</div></div>
            <div class="col"><div class="cell">${holdingPctTxt}</div></div>
            <div class="col"><div class="cell">${holdingProfitTxt}</div></div>
            <div class="col"><div class="cell"><button class="btn btn--danger" data-del="${escapeAttr(r.code)}" style="padding:8px 10px">删除</button></div></div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  tableBody.querySelectorAll('button[data-del]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const code = btn.getAttribute('data-del');
      if(!confirm('确定删除持仓 ' + code + ' ？')) return;
      try{
        await apiJson('/api/holdings/' + encodeURIComponent(code), null, 'DELETE');
        toast('已删除');
        await loadHome();
      }catch(e){
        toast('删除失败：' + e.message);
      }
    });
  });
}

async function loadSearch(){
  setNav({title:'搜索基金', rightText:'返回', rightHref:'#/'});
  footerHintEl.textContent = '支持按基金代码/名称/拼音搜索（数据来自公开列表缓存）。';

  viewEl.innerHTML = `
    <div class="card">
      <input class="input" id="q" placeholder="输入基金代码 / 名称（如 005827、沪深300）" />
      <div class="muted" style="font-size:12px;margin-top:8px">输入后自动搜索，点击结果进入添加。</div>
    </div>
    <div class="card" style="padding:0" id="resultsCard">
      <div class="listItem muted">暂无结果</div>
    </div>
  `;

  const qEl = document.getElementById('q');
  const resultsCard = document.getElementById('resultsCard');
  let timer = null;

  async function doSearch(){
    const q = qEl.value.trim();
    if(!q){
      resultsCard.innerHTML = `<div class="listItem muted">请输入关键词</div>`;
      return;
    }
    resultsCard.innerHTML = `<div class="listItem muted">搜索中...</div>`;
    try{
      const r = await apiGet('/api/search?q=' + encodeURIComponent(q));
      const results = r.results || [];
      if(!results.length){
        resultsCard.innerHTML = `<div class="listItem muted">无匹配结果</div>`;
        return;
      }
      resultsCard.innerHTML = results.map(it => `
        <a class="listItem" href="#/add?code=${encodeURIComponent(it.code)}&name=${encodeURIComponent(it.name || '')}">
          <div class="listTitle">${escapeHtml(it.name || '--')}</div>
          <div class="listSub">${escapeHtml(it.code)} ${it.abbr ? ('· ' + escapeHtml(it.abbr)) : ''}</div>
        </a>
      `).join('');
    }catch(e){
      resultsCard.innerHTML = `<div class="listItem" style="color:var(--muted)">基金列表不可用：${escapeHtml(e.message)}。可稍后重试。</div>`;
    }
  }

  qEl.addEventListener('input', ()=>{
    clearTimeout(timer);
    timer = setTimeout(doSearch, 250);
  });
  qEl.focus();
}

async function loadAdd(params){
  const code = params.get('code') || '';
  const name = params.get('name') ? decodeURIComponent(params.get('name')) : '';

  setNav({title:'添加持仓', rightText:'返回', rightHref:'#/search'});
  footerHintEl.textContent = '录入持仓金额与持有收益（历史累计收益），当日涨幅将自动拉取。';

  viewEl.innerHTML = `
    <div class="card">
      <div class="muted" style="font-size:12px">基金</div>
      <div style="font-size:16px;font-weight:800;margin-top:6px" id="fundName">--</div>
      <div class="muted" style="font-size:12px;margin-top:2px" id="fundCode">${escapeHtml(code)}</div>
      <div class="muted" style="font-size:12px;margin-top:10px" id="quoteHint">拉取估值中...</div>
    </div>

    <div class="card">
      <div class="row">
        <div style="flex:1">
          <div class="muted" style="font-size:12px;margin-bottom:6px">持仓金额（元）</div>
          <input class="input" id="amount" inputmode="decimal" placeholder="如 10000" />
        </div>
      </div>
      <div style="height:10px"></div>
      <div class="row">
        <div style="flex:1">
          <div class="muted" style="font-size:12px;margin-bottom:6px">持有收益（元）</div>
          <input class="input" id="holdingProfit" inputmode="decimal" placeholder="如 256.35（可为负）" />
        </div>
      </div>
      <div style="height:12px"></div>
      <button class="btn" id="submit">添加</button>
    </div>
  `;

  const fundNameEl = document.getElementById('fundName');
  const quoteHintEl = document.getElementById('quoteHint');
  const amountEl = document.getElementById('amount');
  const holdingProfitEl = document.getElementById('holdingProfit');
  const submitEl = document.getElementById('submit');

  fundNameEl.textContent = name || '--';

  try{
    const q = await apiGet('/api/quote/' + encodeURIComponent(code));
    fundNameEl.textContent = q.name || name || '--';
    if(Number.isFinite(q.todayPct)){
      quoteHintEl.innerHTML = `当日估值涨幅：<span class="${clsBySign(q.todayPct)}">${fmtPct(q.todayPct)}</span>（${escapeHtml(q.date || '--')}）`;
    }else{
      quoteHintEl.textContent = '当日估值涨幅：--（接口可能不可用）';
    }
  }catch(e){
    quoteHintEl.textContent = '估值接口异常：' + e.message;
  }

  submitEl.addEventListener('click', async ()=>{
    const amount = Number(amountEl.value);
    const holdingProfit = Number(holdingProfitEl.value);
    if(!Number.isFinite(amount) || amount < 0){
      toast('请填写正确的持仓金额');
      return;
    }
    if(!Number.isFinite(holdingProfit)){
      toast('请填写正确的持有收益');
      return;
    }

    submitEl.disabled = true;
    submitEl.textContent = '添加中...';
    try{
      const fundName = fundNameEl.textContent;
      await apiJson('/api/holdings', { code, name: fundName, amount, holdingProfit });
      toast('添加成功');
      location.hash = '#/';
    }catch(e){
      toast('添加失败：' + e.message);
    }finally{
      submitEl.disabled = false;
      submitEl.textContent = '添加';
    }
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s){
  return escapeHtml(s).replace(/`/g,'');
}

async function router(){
  const { path, params } = parseHash();
  if(path === '/' || path === '/home') return loadHome();
  if(path === '/search') return loadSearch();
  if(path === '/add') return loadAdd(params);
  // default
  location.hash = '#/';
}

window.addEventListener('hashchange', router);
router();

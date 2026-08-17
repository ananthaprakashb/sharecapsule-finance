(() => {
  'use strict';

  const API = 'https://finance-market.sharecapsule.org/v1/ticker';
  const DB_NAME = 'sharecapsule-trade-monitor';
  const STORE = 'local';
  const WATCHLIST_ID = 'watchlist';
  const KEY_ID = 'device-key';
  const MAX_TICKERS = 30;
  const IMPACT_WEIGHT = {high: 3, medium: 2, low: 1};
  const $ = (id) => document.getElementById(id);
  const usd = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 2});
  const compact = new Intl.NumberFormat('en-US', {notation: 'compact', maximumFractionDigits: 1});

  let db;
  let deviceKey;
  let tickers = [];
  let selected = null;
  let currentNews = [];
  let currentFilter = 'all';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const b64 = (bytes) => { let s=''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, {keyPath: 'id'});
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function get(id) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function put(value) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function loadKey() {
    const saved = await get(KEY_ID);
    if (saved?.key) return saved.key;
    const key = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
    await put({id: KEY_ID, key});
    return key;
  }

  async function saveWatchlist() {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(tickers));
    const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv}, deviceKey, plaintext);
    await put({id: WATCHLIST_ID, iv:b64(iv), ciphertext:b64(ciphertext), updatedAt:new Date().toISOString()});
  }

  async function loadWatchlist() {
    const saved = await get(WATCHLIST_ID);
    if (!saved) return [];
    try {
      const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(saved.iv)}, deviceKey, unb64(saved.ciphertext));
      const parsed = JSON.parse(new TextDecoder().decode(plain));
      return Array.isArray(parsed) ? parsed.filter((t) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(t)).slice(0, MAX_TICKERS) : [];
    } catch {
      return [];
    }
  }

  function setStatus(text, error=false) {
    $('status').textContent = text;
    $('status').classList.toggle('error', error);
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '#';
    } catch { return '#'; }
  }

  function renderWatchlist() {
    $('watchlist').innerHTML = tickers.length
      ? tickers.map((ticker) => `<button class="ticker-card ${selected===ticker?'active':''}" data-ticker="${esc(ticker)}" type="button"><strong>${esc(ticker)}</strong><span>Tap to review recent catalysts</span><span class="ticker-actions"><span>On device</span><span class="remove" data-remove="${esc(ticker)}">Remove</span></span></button>`).join('')
      : '<div class="empty">No preferred tickers yet. Add a symbol such as AAPL, MSFT, NVDA, TSLA or AMZN.</div>';

    document.querySelectorAll('[data-ticker]').forEach((button) => button.addEventListener('click', async (event) => {
      const remove = event.target.closest('[data-remove]');
      if (remove) {
        event.stopPropagation();
        tickers = tickers.filter((t) => t !== remove.dataset.remove);
        if (selected === remove.dataset.remove) selected = tickers[0] || null;
        await saveWatchlist();
        renderWatchlist();
        if (selected) await loadTicker(selected); else $('detail').hidden = true;
        return;
      }
      selected = button.dataset.ticker;
      currentFilter = 'all';
      updateFilters();
      renderWatchlist();
      await loadTicker(selected);
    }));
  }

  const money = (value) => Number.isFinite(Number(value)) ? usd.format(Number(value)) : '—';
  const impactBadge = (impact) => {
    const value = ['high','medium'].includes(String(impact).toLowerCase()) ? String(impact).toLowerCase() : 'low';
    return `<span class="badge ${value}">${esc(value)} potential impact</span>`;
  };
  const directionBadge = (direction) => {
    const value = String(direction || 'neutral').toLowerCase();
    if (value === 'positive') return '<span class="badge positive">possible positive</span>';
    if (value === 'negative') return '<span class="badge negative">possible negative</span>';
    return '<span class="badge">neutral / mixed</span>';
  };

  function timeAgo(value) {
    const diff = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(diff)) return '';
    const hours = Math.max(0, Math.floor(diff / 3600000));
    if (hours < 1) return 'Less than 1h ago';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function deriveSummary(news) {
    const s = {positive:0, negative:0, neutral:0, highImpact:0, mediumImpact:0, lowImpact:0, score:0, label:'No recent news', basis:'No ticker-linked news was returned.'};
    if (!news.length) return s;
    let signed=0, total=0;
    for (const item of news) {
      const direction = item.direction === 'positive' || item.direction === 'negative' ? item.direction : 'neutral';
      const impact = item.impact === 'high' || item.impact === 'medium' ? item.impact : 'low';
      s[direction] += 1;
      s[`${impact}Impact`] += 1;
      const weight = IMPACT_WEIGHT[impact];
      total += weight;
      if (direction === 'positive') signed += weight;
      if (direction === 'negative') signed -= weight;
    }
    s.score = total ? Math.round((signed / total) * 100) : 0;
    if (s.score >= 35) s.label = 'Positive news skew';
    else if (s.score >= 10) s.label = 'Slightly positive';
    else if (s.score <= -35) s.label = 'Negative news skew';
    else if (s.score <= -10) s.label = 'Slightly negative';
    else s.label = 'Mixed / neutral';
    s.basis = 'Weighted by article sentiment and event significance. This describes recent news tone, not expected price direction.';
    return s;
  }

  function renderSummary(summary) {
    $('toneLabel').textContent = summary.label || 'Mixed / neutral';
    const score = Number(summary.score || 0);
    $('toneScore').textContent = `${score > 0 ? '+' : ''}${score}`;
    $('toneScore').className = score > 9 ? 'positive-text' : score < -9 ? 'negative-text' : '';
    $('tonePositive').textContent = summary.positive || 0;
    $('toneNegative').textContent = summary.negative || 0;
    $('toneNeutral').textContent = summary.neutral || 0;
    $('toneHigh').textContent = summary.highImpact || 0;
    $('toneBasis').textContent = summary.basis || 'News tone is a research aid, not a price forecast.';
  }

  function updateFilters() {
    document.querySelectorAll('[data-filter]').forEach((button) => button.classList.toggle('active', button.dataset.filter === currentFilter));
  }

  function renderNews() {
    let news = currentNews;
    if (currentFilter === 'positive') news = news.filter((n) => n.direction === 'positive');
    if (currentFilter === 'negative') news = news.filter((n) => n.direction === 'negative');
    if (currentFilter === 'high') news = news.filter((n) => n.impact === 'high');
    $('newsList').innerHTML = news.length ? news.map((item) => `<article class="feed-card"><div class="feed-meta">${directionBadge(item.direction || item.sentiment)}${impactBadge(item.impact)}<span class="badge">${esc(item.publisher || 'Source')}</span><span class="badge">${esc(timeAgo(item.publishedAt))}</span></div><h3>${esc(item.title)}</h3>${item.summary?`<p>${esc(item.summary)}</p>`:''}${item.sentimentReason?`<div class="reason"><strong>Direction context:</strong> ${esc(item.sentimentReason)}</div>`:''}<div class="reason"><strong>Why flagged:</strong> ${esc(item.impactReason || 'Ticker-linked recent news.')}</div><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">Open original article ↗</a></article>`).join('') : '<div class="empty">No recent stories match this filter.</div>';
  }

  function renderFilings(filings) {
    $('filingList').innerHTML = filings.length ? filings.map((item) => `<article class="feed-card"><div class="feed-meta">${impactBadge(item.impact)}<span class="badge">SEC ${esc(item.form)}</span><span class="badge">${esc(item.filed || '')}</span></div><h3>${esc(item.description || item.form)}</h3><div class="reason">Primary-source regulatory filing. Its presence may be important, but the filing itself is not labeled positive or negative.</div><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">Open SEC filing ↗</a></article>`).join('') : '<div class="empty">No recent SEC filing data was returned for this ticker.</div>';
  }

  function renderData(data) {
    $('detail').hidden = false;
    $('companyName').textContent = data.company?.name || 'Company';
    $('tickerName').textContent = data.ticker || selected || '—';
    $('lastPrice').textContent = money(data.quote?.price);
    const change = Number(data.quote?.changePercent);
    $('dayChange').textContent = Number.isFinite(change) ? `${change>=0?'+':''}${change.toFixed(2)}% today` : 'Change unavailable';
    $('dayChange').className = Number.isFinite(change) ? (change >= 0 ? 'up' : 'down') : '';
    $('dayOpen').textContent = money(data.quote?.open);
    $('dayHigh').textContent = money(data.quote?.high);
    $('dayLow').textContent = money(data.quote?.low);
    $('dayVolume').textContent = Number.isFinite(Number(data.quote?.volume)) ? compact.format(Number(data.quote.volume)) : '—';
    $('marketNote').textContent = data.quote?.asOf ? `Market data as of ${new Date(data.quote.asOf).toLocaleString()}. Availability and delay depend on the configured market-data plan.` : 'Market timestamp unavailable.';
    currentNews = Array.isArray(data.news) ? data.news : [];
    renderSummary(data.newsSummary || deriveSummary(currentNews));
    renderNews();
    renderFilings(Array.isArray(data.filings) ? data.filings : []);
  }

  async function loadTicker(ticker) {
    setStatus(`Loading public market data and recent catalysts for ${ticker}…`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${API}?symbol=${encodeURIComponent(ticker)}`, {method:'GET', credentials:'omit', referrerPolicy:'no-referrer', signal:controller.signal, headers:{Accept:'application/json'}});
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Market gateway returned ${response.status}`);
      }
      renderData(await response.json());
      setStatus(`Loaded ${ticker}. Only the ticker symbol was sent; your local finance data was not transmitted.`);
    } catch (error) {
      setStatus(`Could not load ${ticker}: ${error.name === 'AbortError' ? 'request timed out' : error.message}`, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  $('tickerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const ticker = $('tickerInput').value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return setStatus('Enter a valid U.S. ticker symbol using letters, numbers, dot, or dash.', true);
    if (!tickers.includes(ticker)) {
      tickers.push(ticker);
      tickers = tickers.slice(0, MAX_TICKERS);
      await saveWatchlist();
    }
    selected = ticker;
    currentFilter = 'all';
    $('tickerInput').value = '';
    updateFilters();
    renderWatchlist();
    await loadTicker(ticker);
  });

  $('refreshSelected').addEventListener('click', () => selected ? loadTicker(selected) : setStatus('Select or add a ticker first.', true));
  $('newsFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    currentFilter = button.dataset.filter;
    updateFilters();
    renderNews();
  });

  async function init() {
    if (!crypto?.subtle || !indexedDB) return setStatus('This browser does not provide the local security features required by Ticker Watch.', true);
    try {
      db = await openDb();
      deviceKey = await loadKey();
      tickers = await loadWatchlist();
      selected = tickers[0] || null;
      renderWatchlist();
      updateFilters();
      if (selected) await loadTicker(selected);
    } catch (error) {
      console.error(error);
      setStatus('Could not open device-local watchlist storage.', true);
    }
  }

  init();
})();

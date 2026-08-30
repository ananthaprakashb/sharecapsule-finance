(() => {
  'use strict';

  const BILLING_API = 'https://billing.sharecapsule.org';
  const FEATURE = 'briefing_history';
  const DB_NAME = 'sharecapsule-trade-monitor';
  const STORE = 'local';
  const KEY_ID = 'device-key';
  const HISTORY_ID = 'watchlist-briefing-history';
  const HISTORY_VERSION = 1;
  const MAX_ENTRIES = 30;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const $ = (id) => document.getElementById(id);

  let access = {authenticated: false, allowed: false};
  let entries = [];

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clean = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const b64 = (bytes) => {
    let binary = '';
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const unb64 = (text) => Uint8Array.from(atob(String(text || '')), (char) => char.charCodeAt(0));

  function safeHttpsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href.slice(0, 2048) : '';
    } catch {
      return '';
    }
  }

  function safeTicker(value) {
    const ticker = String(value || '').trim().toUpperCase();
    return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : '';
  }

  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function validIso(value, fallback) {
    const time = Date.parse(String(value || ''));
    return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
  }

  function newId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onerror = () => reject(request.error || new Error('Could not open local Ticker Watch storage.'));
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'id'});
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  function getRecord(db, id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      request.onerror = () => reject(request.error || new Error('Could not read local history.'));
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  function putRecord(db, value) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value);
      request.onerror = () => reject(request.error || new Error('Could not save local history.'));
      request.onsuccess = () => resolve();
    });
  }

  function deleteRecord(db, id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
      request.onerror = () => reject(request.error || new Error('Could not clear local history.'));
      request.onsuccess = () => resolve();
    });
  }

  function sanitizeBriefing(data) {
    const now = new Date().toISOString();
    const generatedAt = validIso(data?.generatedAt, now);
    const freshnessWindowHours = Math.max(1, Math.min(168, finiteNumber(data?.freshnessWindowHours, 24)));
    const context = data?.context || {};
    const snapshots = (Array.isArray(data?.snapshots) ? data.snapshots : []).slice(0, 30).map((item) => ({
      ticker: safeTicker(item?.ticker),
      company: clean(item?.company || item?.ticker, 120),
      tone: clean(item?.tone || `No news in the last ${freshnessWindowHours} hours`, 120),
      toneScore: finiteNumber(item?.toneScore, 0),
      highImpactStories: Math.max(0, finiteNumber(item?.highImpactStories, 0))
    })).filter((item) => item.ticker);

    const highlights = (Array.isArray(data?.highlights) ? data.highlights : []).slice(0, 8).map((item) => {
      const tickers = (Array.isArray(item?.tickers) ? item.tickers : [item?.ticker]).map(safeTicker).filter(Boolean).slice(0, 30);
      return {
        kind: item?.kind === 'filing' ? 'filing' : 'news',
        ticker: tickers[0] || safeTicker(item?.ticker),
        tickers,
        company: clean(item?.company, 120),
        title: clean(item?.title || 'Untitled story', 300),
        summary: clean(item?.summary, 1500),
        direction: ['positive', 'negative'].includes(item?.direction) ? item.direction : 'neutral',
        impact: ['high', 'medium'].includes(item?.impact) ? item.impact : 'low',
        why: clean(item?.why, 600),
        source: clean(item?.source || 'News source', 120),
        publishedAt: validIso(item?.publishedAt, generatedAt),
        url: safeHttpsUrl(item?.url)
      };
    }).filter((item) => item.ticker && item.title);

    const remainingTickers = (Array.isArray(data?.remainingTickers) ? data.remainingTickers : []).map(safeTicker).filter(Boolean).slice(0, 30);

    return {
      id: newId(),
      savedAt: now,
      generatedAt,
      freshnessWindowHours,
      windowStart: validIso(data?.windowStart, new Date(Date.parse(generatedAt) - freshnessWindowHours * 3600000).toISOString()),
      requestedTickerCount: Math.max(0, finiteNumber(data?.requestedTickerCount, snapshots.length)),
      loadedTickerCount: Math.max(0, finiteNumber(data?.loadedTickerCount, snapshots.length)),
      context: {
        positive: Math.max(0, finiteNumber(context.positive, 0)),
        negative: Math.max(0, finiteNumber(context.negative, 0)),
        neutral: Math.max(0, finiteNumber(context.neutral, 0)),
        highImpact: Math.max(0, finiteNumber(context.highImpact, 0)),
        tone: clean(context.tone || 'mixed / neutral', 120)
      },
      snapshots,
      highlights,
      remainingTickers,
      failures: [],
      guardrail: clean(data?.guardrail || 'This briefing summarizes public market information for research and does not recommend a trade.', 500)
    };
  }

  async function readHistory() {
    const db = await openDb();
    try {
      const [historyRecord, keyRecord] = await Promise.all([getRecord(db, HISTORY_ID), getRecord(db, KEY_ID)]);
      if (!historyRecord) return [];
      if (!keyRecord?.key) throw new Error('The device encryption key is unavailable.');
      const plaintext = await crypto.subtle.decrypt(
        {name: 'AES-GCM', iv: unb64(historyRecord.iv)},
        keyRecord.key,
        unb64(historyRecord.ciphertext)
      );
      const parsed = JSON.parse(decoder.decode(plaintext));
      if (parsed?.version !== HISTORY_VERSION || !Array.isArray(parsed?.entries)) throw new Error('The encrypted history format is not recognized.');
      return parsed.entries
        .filter((entry) => entry && typeof entry === 'object' && entry.id)
        .sort((a, b) => Date.parse(b.generatedAt || b.savedAt || 0) - Date.parse(a.generatedAt || a.savedAt || 0))
        .slice(0, MAX_ENTRIES);
    } finally {
      db.close();
    }
  }

  async function writeHistory(nextEntries) {
    const db = await openDb();
    try {
      const keyRecord = await getRecord(db, KEY_ID);
      if (!keyRecord?.key) throw new Error('The device encryption key is unavailable.');
      const kept = nextEntries.slice(0, MAX_ENTRIES);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify({version: HISTORY_VERSION, entries: kept}));
      const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, keyRecord.key, plaintext);
      await putRecord(db, {
        id: HISTORY_ID,
        version: HISTORY_VERSION,
        iv: b64(iv),
        ciphertext: b64(new Uint8Array(ciphertext)),
        updatedAt: new Date().toISOString()
      });
      entries = kept;
    } finally {
      db.close();
    }
  }

  async function clearHistory() {
    const db = await openDb();
    try {
      await deleteRecord(db, HISTORY_ID);
      entries = [];
    } finally {
      db.close();
    }
  }

  function ensureUi() {
    if ($('briefingHistoryPanel')) return true;
    const anchor = document.querySelector('.watchlist-briefing-panel');
    if (!anchor) return false;
    const panel = document.createElement('section');
    panel.id = 'briefingHistoryPanel';
    panel.className = 'panel briefing-history-panel';
    panel.setAttribute('aria-labelledby', 'briefingHistoryTitle');
    panel.innerHTML = `
      <div class="briefing-history-heading">
        <div><p class="eyebrow">Plus memory</p><h2 id="briefingHistoryTitle">Encrypted briefing history</h2><p>Reopen recent watchlist briefings without fetching the news again. Up to ${MAX_ENTRIES} briefings are encrypted with this device's existing Ticker Watch key.</p></div>
        <span id="briefingHistoryBadge" class="watchlist-plus-badge">Checking Plus…</span>
      </div>
      <div class="briefing-history-toolbar">
        <p id="briefingHistoryStatus">Checking history access…</p>
        <div><a id="briefingHistoryAccount" class="secondary history-account-link" href="/account/" hidden>View Plus</a><button id="briefingHistoryClear" class="secondary" type="button" disabled>Clear history</button></div>
      </div>
      <div class="briefing-history-privacy"><strong>Device-only:</strong> saved briefings are AES-GCM ciphertext in this browser's IndexedDB. They are not uploaded, synced between devices, or stored by billing, the briefing Worker, or the market Worker.</div>
      <div id="briefingHistoryList" class="briefing-history-list"><div class="briefing-empty">No saved briefings yet.</div></div>`;
    anchor.insertAdjacentElement('afterend', panel);

    if (!document.querySelector('link[data-briefing-history-style]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './briefing-history.css';
      link.dataset.briefingHistoryStyle = 'true';
      document.head.appendChild(link);
    }
    return true;
  }

  function historyDate(value) {
    const time = Date.parse(String(value || ''));
    return Number.isFinite(time) ? new Date(time).toLocaleString() : 'Unknown time';
  }

  function renderHistory() {
    const list = $('briefingHistoryList');
    const clear = $('briefingHistoryClear');
    if (!list || !clear) return;
    clear.disabled = !access.allowed || entries.length === 0;

    if (!access.authenticated) {
      list.innerHTML = '<div class="briefing-history-locked"><strong>Sign in to view encrypted history</strong><span>The ciphertext remains on this device and is not deleted.</span></div>';
      return;
    }
    if (!access.allowed) {
      list.innerHTML = '<div class="briefing-history-locked"><strong>Briefing history is a Plus feature</strong><span>Your encrypted history remains on this device and will be available again when the entitlement is active.</span></div>';
      return;
    }
    if (!entries.length) {
      list.innerHTML = '<div class="briefing-empty">No saved briefings yet. Your next successful whole-watchlist briefing will be encrypted here automatically.</div>';
      return;
    }

    list.innerHTML = entries.map((entry) => {
      const tickers = (entry.snapshots || []).map((item) => item.ticker).filter(Boolean);
      const shown = tickers.slice(0, 8).join(', ');
      const more = tickers.length > 8 ? ` +${tickers.length - 8}` : '';
      const highlights = Array.isArray(entry.highlights) ? entry.highlights.length : 0;
      const tone = clean(entry.context?.tone || 'mixed / neutral', 80);
      return `<article class="briefing-history-item" data-history-id="${esc(entry.id)}">
        <div class="briefing-history-meta"><span>${esc(historyDate(entry.generatedAt))}</span><span>${esc(`${entry.freshnessWindowHours || 24}h window`)}</span></div>
        <div class="briefing-history-summary"><strong>${esc(`${entry.loadedTickerCount || tickers.length} ticker${(entry.loadedTickerCount || tickers.length) === 1 ? '' : 's'}`)}</strong><span>${esc(`${highlights} highlight${highlights === 1 ? '' : 's'} · ${tone}`)}</span><small>${esc(shown || 'Ticker coverage unavailable')}${esc(more)}</small></div>
        <div class="briefing-history-actions"><button class="secondary" type="button" data-history-action="open">Open</button><button class="secondary history-delete" type="button" data-history-action="delete">Delete</button></div>
      </article>`;
    }).join('');
  }

  async function refreshHistory() {
    if (!access.allowed) {
      entries = [];
      renderHistory();
      return;
    }
    try {
      entries = await readHistory();
      $('briefingHistoryStatus').textContent = entries.length
        ? `${entries.length} encrypted briefing${entries.length === 1 ? '' : 's'} saved on this device. Newest entries are shown first.`
        : 'No encrypted briefing history is saved on this device yet.';
    } catch (error) {
      entries = [];
      $('briefingHistoryStatus').textContent = `Encrypted history could not be opened: ${error.message}`;
    }
    renderHistory();
  }

  async function fetchAccess() {
    try {
      const response = await fetch(`${BILLING_API}/v1/feature/${FEATURE}`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: {Accept: 'application/json'}
      });
      if (!response.ok) throw new Error(`account service returned ${response.status}`);
      access = await response.json();
    } catch (error) {
      access = {authenticated: false, allowed: false};
      $('briefingHistoryStatus').textContent = `Could not verify history access: ${error.message}`;
    }

    const badge = $('briefingHistoryBadge');
    const account = $('briefingHistoryAccount');
    if (access.authenticated && access.allowed) {
      badge.textContent = 'Plus history active';
      badge.classList.add('active');
      account.hidden = true;
    } else if (access.authenticated) {
      badge.textContent = 'Plus required';
      badge.classList.remove('active');
      account.hidden = false;
      $('briefingHistoryStatus').textContent = 'Your local encrypted entries are retained, but viewing and saving history requires Plus.';
    } else {
      badge.textContent = 'Plus · sign in';
      badge.classList.remove('active');
      account.hidden = false;
      $('briefingHistoryStatus').textContent = 'Sign in to verify access. Existing encrypted history remains untouched.';
    }
    await refreshHistory();
  }

  async function saveGenerated(event) {
    if (!access.allowed) return;
    const data = event?.detail?.briefing;
    if (!data || typeof data !== 'object') return;
    try {
      const next = sanitizeBriefing(data);
      const current = await readHistory();
      const deduped = current.filter((entry) => entry.generatedAt !== next.generatedAt);
      await writeHistory([next, ...deduped]);
      $('briefingHistoryStatus').textContent = `Saved this briefing locally. ${entries.length} encrypted briefing${entries.length === 1 ? '' : 's'} retained on this device.`;
      renderHistory();
    } catch (error) {
      $('briefingHistoryStatus').textContent = `Briefing was generated, but local encrypted history could not be saved: ${error.message}`;
    }
  }

  async function historyAction(event) {
    const button = event.target.closest('button[data-history-action]');
    if (!button || !access.allowed) return;
    const item = button.closest('[data-history-id]');
    const entry = entries.find((candidate) => candidate.id === item?.dataset.historyId);
    if (!entry) return;

    if (button.dataset.historyAction === 'open') {
      window.dispatchEvent(new CustomEvent('sharecapsule:watchlist-briefing-open-history', {detail: {briefing: entry}}));
      return;
    }
    if (button.dataset.historyAction === 'delete') {
      try {
        await writeHistory(entries.filter((candidate) => candidate.id !== entry.id));
        $('briefingHistoryStatus').textContent = `${entries.length} encrypted briefing${entries.length === 1 ? '' : 's'} remain on this device.`;
        renderHistory();
      } catch (error) {
        $('briefingHistoryStatus').textContent = `Could not delete that history entry: ${error.message}`;
      }
    }
  }

  async function clearAll() {
    if (!access.allowed || !entries.length) return;
    if (!window.confirm('Clear all encrypted watchlist briefing history from this device? This cannot be undone.')) return;
    try {
      await clearHistory();
      $('briefingHistoryStatus').textContent = 'Encrypted briefing history was cleared from this device.';
      renderHistory();
    } catch (error) {
      $('briefingHistoryStatus').textContent = `Could not clear encrypted history: ${error.message}`;
    }
  }

  async function init() {
    if (!ensureUi()) return;
    $('briefingHistoryList').addEventListener('click', historyAction);
    $('briefingHistoryClear').addEventListener('click', clearAll);
    window.addEventListener('sharecapsule:watchlist-briefing-generated', saveGenerated);
    await fetchAccess();
  }

  init();
})();

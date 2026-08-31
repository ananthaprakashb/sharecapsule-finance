(() => {
  'use strict';

  const BILLING_API = 'https://billing.sharecapsule.org';
  const MARKET_API = 'https://finance-market.sharecapsule.org/v1/ticker';
  const FEATURE = 'briefing_history';
  const DB_NAME = 'sharecapsule-trade-monitor';
  const STORE = 'local';
  const KEY_ID = 'device-key';
  const CHECKPOINT_PREFIX = 'since-last-checked:';
  const MAX_SEEN = 500;
  const MAX_RENDERED = 8;
  const $ = (id) => document.getElementById(id);
  const nativeFetch = window.fetch.bind(window);

  let access = {authenticated: false, allowed: false, checked: false};
  let accessPromise;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const b64 = (bytes) => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  }

  function ensureUi() {
    if (!$('sinceLastCheckedPanel')) {
      const anchor = $('freeSnapshotPanel') || document.querySelector('.tone-panel');
      if (!anchor) return false;
      const panel = document.createElement('article');
      panel.id = 'sinceLastCheckedPanel';
      panel.className = 'panel since-panel';
      panel.setAttribute('aria-labelledby', 'sinceLastCheckedTitle');
      panel.innerHTML = `
        <div class="since-heading">
          <div><p class="eyebrow">Plus research memory</p><h2 id="sinceLastCheckedTitle">Since I last checked</h2><p>See what newly surfaced for this ticker since the previous successful check on this device.</p></div>
          <span id="sinceAccessBadge" class="since-badge">Checking Plus…</span>
        </div>
        <div id="sinceLocked" class="since-lock"><div><strong>Checking access…</strong><span>The core single-ticker research above remains free.</span></div><a href="/account/?return_to=/trade/">View Plus</a></div>
        <div id="sinceUnlocked" hidden>
          <div class="since-summary">
            <div class="since-stat"><span>New stories</span><strong id="sinceStoryCount">0</strong></div>
            <div class="since-stat high"><span>High-impact</span><strong id="sinceHighCount">0</strong></div>
            <div class="since-stat"><span>New SEC filings</span><strong id="sinceFilingCount">0</strong></div>
            <div class="since-stat"><span>Directional</span><strong id="sinceDirectionalCount">0</strong></div>
          </div>
          <p id="sinceStatus" class="since-status" aria-live="polite">Load a ticker to create a private checkpoint.</p>
          <div id="sinceList" class="since-list"><div class="since-empty">The first successful Plus check creates a baseline. The next refresh shows what is new to this device.</div></div>
        </div>
        <div class="since-privacy"><strong>Privacy boundary:</strong> the checkpoint is encrypted with the same device-local AES-GCM key used by Ticker Watch. Billing receives only an entitlement check. The checkpoint is not sent with market requests and is not yet synced across devices.</div>`;
      anchor.insertAdjacentElement('afterend', panel);
    }
    if (!document.querySelector('link[data-since-last-checked-style]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './since-last-checked.css';
      link.dataset.sinceLastCheckedStyle = 'true';
      document.head.appendChild(link);
    }
    return true;
  }

  function renderAccess() {
    if (!ensureUi()) return;
    const badge = $('sinceAccessBadge');
    const locked = $('sinceLocked');
    const unlocked = $('sinceUnlocked');
    if (!access.checked) return;
    if (access.allowed) {
      badge.textContent = 'Plus active';
      badge.classList.add('active');
      locked.hidden = true;
      unlocked.hidden = false;
      return;
    }
    badge.classList.remove('active');
    unlocked.hidden = true;
    locked.hidden = false;
    const copy = locked.querySelector('div');
    const link = locked.querySelector('a');
    if (!access.authenticated) {
      badge.textContent = 'Plus · sign in';
      copy.innerHTML = '<strong>Keep a private research checkpoint.</strong><span>Sign in to use “Since I last checked.” Your free single-ticker research is unchanged.</span>';
      link.textContent = 'Sign in / view Plus';
    } else {
      badge.textContent = 'Plus required';
      copy.innerHTML = '<strong>Turn repeated checking into a delta.</strong><span>Plus remembers the evidence already seen on this device and highlights what newly surfaced on the next check.</span>';
      link.textContent = 'Upgrade to Plus';
    }
  }

  async function fetchAccess() {
    ensureUi();
    try {
      const response = await nativeFetch(`${BILLING_API}/v1/feature/${FEATURE}`, {
        method: 'GET', credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer', headers: {Accept: 'application/json'}
      });
      if (!response.ok) throw new Error(`account service returned ${response.status}`);
      const body = await response.json();
      access = {authenticated: Boolean(body.authenticated), allowed: Boolean(body.allowed), checked: true};
    } catch (error) {
      access = {authenticated: false, allowed: false, checked: true};
      const badge = $('sinceAccessBadge');
      if (badge) badge.textContent = 'Access unavailable';
      console.warn('Since I last checked access could not be verified.', error);
    }
    renderAccess();
    return access;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'id'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getRecord(db, id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function putRecord(db, value) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function waitForKey(db) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const record = await getRecord(db, KEY_ID);
      if (record?.key) return record.key;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('device encryption key unavailable');
  }

  async function readCheckpoint(db, key, ticker) {
    const record = await getRecord(db, `${CHECKPOINT_PREFIX}${ticker}`);
    if (!record?.iv || !record?.ciphertext) return null;
    try {
      const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(record.iv)}, key, unb64(record.ciphertext));
      const parsed = JSON.parse(new TextDecoder().decode(plain));
      return parsed?.ticker === ticker ? parsed : null;
    } catch { return null; }
  }

  async function writeCheckpoint(db, key, checkpoint) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(checkpoint));
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, plaintext);
    await putRecord(db, {id: `${CHECKPOINT_PREFIX}${checkpoint.ticker}`, iv: b64(iv), ciphertext: b64(ciphertext), updatedAt: checkpoint.checkedAt});
  }

  function itemKey(kind, url, title, date) {
    const safe = safeUrl(url);
    return `${kind}|${safe || `${clean(title).toLowerCase()}|${clean(date)}`}`;
  }

  function normalizeApiData(data) {
    const ticker = clean(data?.ticker || $('tickerName')?.textContent).toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return null;
    const news = (Array.isArray(data?.news) ? data.news : []).map((item) => ({
      kind: 'news', key: itemKey('news', item.url, item.title, item.publishedAt), title: clean(item.title), summary: clean(item.summary), url: safeUrl(item.url),
      direction: ['positive','negative'].includes(String(item.direction || item.sentiment).toLowerCase()) ? String(item.direction || item.sentiment).toLowerCase() : 'neutral',
      impact: ['high','medium'].includes(String(item.impact).toLowerCase()) ? String(item.impact).toLowerCase() : 'low', date: item.publishedAt || ''
    })).filter((item) => item.title);
    const filings = (Array.isArray(data?.filings) ? data.filings : []).map((item) => ({
      kind: 'filing', key: itemKey('filing', item.url, item.description || item.form, item.filed), title: clean(item.description || item.form), summary: `SEC ${clean(item.form)} · ${clean(item.filed)}`,
      url: safeUrl(item.url), direction: 'neutral', impact: ['high','medium'].includes(String(item.impact).toLowerCase()) ? String(item.impact).toLowerCase() : 'low', date: item.filed || ''
    })).filter((item) => item.title);
    return {ticker, news, filings};
  }

  function normalizeDomData() {
    const ticker = clean($('tickerName')?.textContent).toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || $('detail')?.hidden) return null;
    const readCards = (selector, kind) => Array.from(document.querySelectorAll(selector)).map((card) => {
      const title = clean(card.querySelector('h3')?.textContent);
      const url = safeUrl(card.querySelector('a[href]')?.href);
      const badges = Array.from(card.querySelectorAll('.badge')).map((node) => clean(node.textContent).toLowerCase());
      const impact = badges.some((x) => x.includes('high')) ? 'high' : badges.some((x) => x.includes('medium')) ? 'medium' : 'low';
      const direction = badges.some((x) => x.includes('possible positive')) ? 'positive' : badges.some((x) => x.includes('possible negative')) ? 'negative' : 'neutral';
      return {kind, key: itemKey(kind, url, title, badges.join('|')), title, summary: clean(card.querySelector('p')?.textContent), url, direction, impact, date: ''};
    }).filter((item) => item.title);
    return {ticker, news: readCards('#newsList .feed-card', 'news'), filings: readCards('#filingList .feed-card', 'filing')};
  }

  function uniqueKeys(current, previous = []) {
    const out = [];
    const seen = new Set();
    for (const key of [...current, ...previous]) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= MAX_SEEN) break;
    }
    return out;
  }

  function formatChecked(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'your previous check';
  }

  function renderDelta(ticker, previous, newNews, newFilings) {
    const directional = newNews.filter((item) => item.direction === 'positive' || item.direction === 'negative');
    const high = [...newNews, ...newFilings].filter((item) => item.impact === 'high');
    $('sinceStoryCount').textContent = String(newNews.length);
    $('sinceHighCount').textContent = String(high.length);
    $('sinceFilingCount').textContent = String(newFilings.length);
    $('sinceDirectionalCount').textContent = String(directional.length);

    if (!previous) {
      $('sinceStatus').innerHTML = `<strong>${esc(ticker)} baseline created on this device.</strong> The next successful refresh will compare newly surfaced evidence against this encrypted checkpoint.`;
      $('sinceList').innerHTML = '<div class="since-empty">Nothing is labeled “new” on the first check because there is no earlier baseline yet.</div>';
      return;
    }

    const allNew = [...newNews, ...newFilings].slice(0, MAX_RENDERED);
    const total = newNews.length + newFilings.length;
    $('sinceStatus').innerHTML = total
      ? `<strong>Last checked ${esc(formatChecked(previous.checkedAt))}.</strong> ${newNews.length} newly surfaced stor${newNews.length === 1 ? 'y' : 'ies'} and ${newFilings.length} new SEC filing${newFilings.length === 1 ? '' : 's'} are new to this device's research memory.`
      : `<strong>Last checked ${esc(formatChecked(previous.checkedAt))}.</strong> No newly surfaced stories or SEC filings in the current returned evidence set.`;
    $('sinceList').innerHTML = allNew.length ? allNew.map((item) => {
      const meta = [`<span>${item.kind === 'filing' ? 'SEC filing' : 'news'}</span>`, `<span class="${esc(item.impact)}">${esc(item.impact)} impact</span>`];
      if (item.kind === 'news') meta.push(`<span class="${esc(item.direction)}">${esc(item.direction === 'neutral' ? 'neutral / mixed' : `possible ${item.direction}`)}</span>`);
      return `<article class="since-item"><div class="since-item-meta">${meta.join('')}</div><h3>${esc(item.title)}</h3>${item.summary ? `<p>${esc(item.summary)}</p>` : ''}${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open original source ↗</a>` : ''}</article>`;
    }).join('') : '<div class="since-empty">You are caught up on the evidence currently returned for this ticker.</div>';
  }

  async function processSnapshot(snapshot) {
    if (!snapshot || !ensureUi()) return;
    await accessPromise;
    if (!access.allowed) return;
    const db = await openDb();
    try {
      const key = await waitForKey(db);
      const previous = await readCheckpoint(db, key, snapshot.ticker);
      const previousNews = new Set(Array.isArray(previous?.seenNews) ? previous.seenNews : []);
      const previousFilings = new Set(Array.isArray(previous?.seenFilings) ? previous.seenFilings : []);
      const newNews = previous ? snapshot.news.filter((item) => !previousNews.has(item.key)) : [];
      const newFilings = previous ? snapshot.filings.filter((item) => !previousFilings.has(item.key)) : [];
      renderDelta(snapshot.ticker, previous, newNews, newFilings);
      await writeCheckpoint(db, key, {
        ticker: snapshot.ticker,
        checkedAt: new Date().toISOString(),
        seenNews: uniqueKeys(snapshot.news.map((item) => item.key), previous?.seenNews),
        seenFilings: uniqueKeys(snapshot.filings.map((item) => item.key), previous?.seenFilings)
      });
    } catch (error) {
      console.warn('Since I last checked checkpoint could not be processed.', error);
      if ($('sinceStatus')) $('sinceStatus').textContent = 'The local research checkpoint could not be opened on this device. Core ticker research is unaffected.';
    } finally {
      db.close();
    }
  }

  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    try {
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (String(requestUrl || '').startsWith(MARKET_API) && response.ok) {
        response.clone().json().then((data) => processSnapshot(normalizeApiData(data))).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  function scheduleDomFallback() {
    setTimeout(() => processSnapshot(normalizeDomData()), 180);
  }

  function init() {
    if (!crypto?.subtle || !indexedDB) return;
    ensureUi();
    accessPromise = fetchAccess();
    const tickerName = $('tickerName');
    if (tickerName) new MutationObserver(scheduleDomFallback).observe(tickerName, {childList: true, subtree: true, characterData: true});
    setTimeout(scheduleDomFallback, 700);
  }

  init();
})();
(() => {
  'use strict';

  const BILLING_API = 'https://billing.sharecapsule.org';
  const BRIEFING_API = 'https://briefing.sharecapsule.org/v1/watchlist';
  const FEATURE = 'daily_watchlist_briefing';
  const DB_NAME = 'sharecapsule-trade-monitor';
  const STORE = 'local';
  const WATCHLIST_ID = 'watchlist';
  const KEY_ID = 'device-key';
  const MAX_TICKERS = 30;
  const $ = (id) => document.getElementById(id);
  const synth = window.speechSynthesis;

  let access = {authenticated: false, allowed: false};
  let briefing = null;
  let speechSegments = [];
  let speaking = false;
  let speechIndex = -1;

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  }

  function setStatus(message, error = false) {
    const node = $('watchlistBriefingStatus');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('error', error);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
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

  async function readWatchlist() {
    const db = await openDb();
    try {
      const [saved, keyRecord] = await Promise.all([getRecord(db, WATCHLIST_ID), getRecord(db, KEY_ID)]);
      if (!saved || !keyRecord?.key) return [];
      const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(saved.iv)}, keyRecord.key, unb64(saved.ciphertext));
      const parsed = JSON.parse(new TextDecoder().decode(plaintext));
      return Array.isArray(parsed)
        ? parsed.map((ticker) => String(ticker || '').toUpperCase()).filter((ticker) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)).slice(0, MAX_TICKERS)
        : [];
    } finally {
      db.close();
    }
  }

  function ensureUi() {
    if (!$('watchlistBriefingGenerate')) {
      const watchSection = document.querySelector('.watch-section');
      if (!watchSection) return false;
      const panel = document.createElement('section');
      panel.className = 'panel watchlist-briefing-panel';
      panel.setAttribute('aria-labelledby', 'watchlistBriefingTitle');
      panel.innerHTML = `
        <div class="watchlist-briefing-heading">
          <div><p class="eyebrow">Plus intelligence</p><h2 id="watchlistBriefingTitle">Whole-watchlist briefing</h2><p>Rank the most important returned news and SEC developments across the tickers encrypted on this device, then listen to one concise research briefing.</p></div>
          <span id="watchlistBriefingAccess" class="watchlist-plus-badge">Checking Plus…</span>
        </div>
        <div class="watchlist-briefing-actions">
          <button id="watchlistBriefingGenerate" class="primary" type="button" disabled>Checking access…</button>
          <button id="watchlistBriefingPlay" class="secondary" type="button" disabled>Play briefing</button>
          <button id="watchlistBriefingPause" class="secondary" type="button" disabled>Pause</button>
          <button id="watchlistBriefingStop" class="secondary" type="button" disabled>Stop</button>
          <label><span>Speed</span><select id="watchlistBriefingRate"><option value="0.9">0.9×</option><option value="1" selected>1.0×</option><option value="1.15">1.15×</option><option value="1.3">1.3×</option></select></label>
          <span id="watchlistBriefingCount" class="watchlist-brief-progress">0 tickers on this device</span>
        </div>
        <p id="watchlistBriefingStatus" class="watchlist-briefing-status">Checking Plus access…</p>
        <div class="watchlist-briefing-privacy"><strong>Privacy boundary:</strong> billing verifies your Plus entitlement without receiving the watchlist. Only when you generate a briefing does this browser send ticker symbols to the separate briefing service using a short-lived capability token. No user identity, finance vault, balances, holdings, transactions or cost basis are sent with that request.</div>
        <div id="watchlistBriefingContext" class="watchlist-brief-context" hidden>
          <div><span>Watchlist tone</span><strong id="watchlistBriefingTone">—</strong></div>
          <div><span>Possible positive</span><strong id="watchlistBriefingPositive">0</strong></div>
          <div><span>Possible negative</span><strong id="watchlistBriefingNegative">0</strong></div>
          <div><span>High-impact stories</span><strong id="watchlistBriefingHigh">0</strong></div>
        </div>
        <div id="watchlistBriefingSnapshots" class="watchlist-brief-snapshots"></div>
        <div id="watchlistBriefingFailures" class="watchlist-brief-failures" hidden></div>
        <div class="watchlist-brief-transcript-head"><h3>Ranked highlights & sources</h3><span id="watchlistBriefingProgress" class="watchlist-brief-progress">0 / 0</span></div>
        <div id="watchlistBriefingTranscript" class="watchlist-brief-transcript"><div class="briefing-empty">Generate a Plus briefing to see cross-watchlist highlights.</div></div>`;
      watchSection.insertAdjacentElement('afterend', panel);
    }
    if (!document.querySelector('link[data-watchlist-briefing-style]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './watchlist-briefing.css';
      link.dataset.watchlistBriefingStyle = 'true';
      document.head.appendChild(link);
    }
    return true;
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
      setStatus(`Could not verify Plus access: ${error.message}`, true);
    }
    renderAccess();
  }

  async function renderAccess() {
    const button = $('watchlistBriefingGenerate');
    const badge = $('watchlistBriefingAccess');
    if (!button || !badge) return;
    let count = 0;
    try { count = (await readWatchlist()).length; } catch {}
    $('watchlistBriefingCount').textContent = `${count} ticker${count === 1 ? '' : 's'} on this device`;

    if (!access.authenticated) {
      badge.textContent = 'Plus · sign in';
      badge.classList.remove('active');
      button.textContent = 'Sign in / view Plus';
      button.disabled = false;
      if (!briefing) setStatus('Sign in with Google to use whole-watchlist briefings. Your watchlist stays on this device until you explicitly generate one.');
      return;
    }
    if (!access.allowed) {
      badge.textContent = 'Plus required';
      badge.classList.remove('active');
      button.textContent = 'Upgrade to Plus';
      button.disabled = false;
      if (!briefing) setStatus('Whole-watchlist briefing is a Plus feature. Your existing single-ticker briefing remains available for free.');
      return;
    }
    badge.textContent = 'Plus active';
    badge.classList.add('active');
    button.textContent = 'Generate watchlist briefing';
    button.disabled = count === 0;
    if (!briefing) setStatus(count ? `Ready to review ${count} ticker${count === 1 ? '' : 's'} without sending your finance vault.` : 'Add at least one ticker to generate a watchlist briefing.');
  }

  async function capability() {
    const response = await fetch(`${BILLING_API}/v1/capability/${FEATURE}`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: {Accept: 'application/json'}
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Sign in is required.');
    if (response.status === 403) throw new Error('An active Plus subscription is required.');
    if (!response.ok || !body.token) throw new Error(body.error || `capability service returned ${response.status}`);
    return body.token;
  }

  async function requestBriefing(tickers, token) {
    const response = await fetch(BRIEFING_API, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({tickers})
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `briefing service returned ${response.status}`);
    return body;
  }

  function formatPercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number >= 0 ? '+' : ''}${number.toFixed(2)}%` : 'change unavailable';
  }

  function buildSpeechSegments(data) {
    const context = data.context || {};
    const result = [{
      title: 'Watchlist overview',
      text: `Here is your ShareCapsule Finance Plus watchlist briefing for ${data.loadedTickerCount || 0} ticker${data.loadedTickerCount === 1 ? '' : 's'}. Recent coverage has a ${clean(context.tone || 'mixed or neutral')} tone, with ${context.positive || 0} potentially positive stories, ${context.negative || 0} potentially negative stories, and ${context.highImpact || 0} high-impact stories. Here are the developments ranked highest for review.`
    }];

    (data.highlights || []).forEach((item, index) => {
      const tickers = Array.isArray(item.tickers) && item.tickers.length ? item.tickers.join(', ') : item.ticker;
      const direction = item.direction === 'positive' ? 'potentially positive' : item.direction === 'negative' ? 'potentially negative' : 'neutral or mixed';
      const kind = item.kind === 'filing' ? 'SEC filing' : 'news item';
      result.push({
        title: item.title,
        text: `Highlight ${index + 1}, for ${tickers}. This ${kind} is ranked ${item.impact || 'low'} impact and ${direction}. ${clean(item.title)}. ${clean(item.summary)} ${clean(item.why)}`
      });
    });

    if ((data.remainingTickers || []).length) {
      result.push({
        title: 'Other watchlist names',
        text: `The remaining watchlist tickers did not place an event in the top ${data.highlights?.length || 0} highlights: ${data.remainingTickers.join(', ')}. This does not mean nothing changed; it means other returned events ranked higher in this briefing.`
      });
    }
    result.push({
      title: 'Research guardrail',
      text: 'That concludes the watchlist briefing. It summarizes public market information and recent coverage for research. It does not predict price direction or recommend a trade. Review material information at the original source before making a financial decision.'
    });
    return result;
  }

  function renderBriefing(data) {
    const context = data.context || {};
    $('watchlistBriefingContext').hidden = false;
    $('watchlistBriefingTone').textContent = context.tone || 'Mixed / neutral';
    $('watchlistBriefingPositive').textContent = context.positive || 0;
    $('watchlistBriefingNegative').textContent = context.negative || 0;
    $('watchlistBriefingHigh').textContent = context.highImpact || 0;

    const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
    $('watchlistBriefingSnapshots').innerHTML = snapshots.length
      ? snapshots.map((item) => `<div class="watchlist-brief-snapshot"><strong>${esc(item.ticker)}</strong><span>${esc(item.company)}</span><span>${esc(formatPercent(item.changePercent))} · ${esc(item.tone)}</span></div>`).join('')
      : '<div class="briefing-empty">No ticker snapshots were returned.</div>';

    const highlights = Array.isArray(data.highlights) ? data.highlights : [];
    $('watchlistBriefingTranscript').innerHTML = highlights.length
      ? highlights.map((item, index) => {
          const tickers = Array.isArray(item.tickers) && item.tickers.length ? item.tickers.join(', ') : item.ticker;
          const url = safeUrl(item.url);
          return `<article class="watchlist-brief-item"><div class="watchlist-brief-meta"><span>${index + 1}</span><span>${esc(tickers)}</span><span>${esc(item.impact || 'low')} impact</span><span>${esc(item.kind === 'filing' ? 'SEC filing' : item.direction || 'neutral')}</span></div><h3>${esc(item.title)}</h3>${item.summary ? `<p>${esc(item.summary)}</p>` : ''}${item.why ? `<div class="watchlist-brief-why">Why ranked: ${esc(item.why)}</div>` : ''}${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open original source ↗</a>` : ''}</article>`;
        }).join('')
      : '<div class="briefing-empty">No recent events were ranked for this watchlist.</div>';

    const failures = Array.isArray(data.failures) ? data.failures : [];
    $('watchlistBriefingFailures').hidden = failures.length === 0;
    $('watchlistBriefingFailures').textContent = failures.length ? `Could not load: ${failures.map((item) => item.ticker).join(', ')}. The briefing used the tickers that loaded successfully.` : '';

    speechSegments = buildSpeechSegments(data);
    $('watchlistBriefingPlay').disabled = speechSegments.length === 0 || !synth;
    $('watchlistBriefingProgress').textContent = `0 / ${speechSegments.length}`;
  }

  function setSpeechActive(index) {
    speechIndex = index;
    $('watchlistBriefingProgress').textContent = speechSegments.length && index >= 0 ? `${index + 1} / ${speechSegments.length}` : `0 / ${speechSegments.length}`;
  }

  function preferredVoice() {
    if (!synth) return null;
    const voices = synth.getVoices();
    return voices.find((voice) => /^en(-|_)/i.test(voice.lang) && voice.localService && voice.default)
      || voices.find((voice) => /^en(-|_)/i.test(voice.lang) && voice.localService)
      || null;
  }

  function speak(index) {
    if (!synth || !speaking || index >= speechSegments.length) {
      if (index >= speechSegments.length) {
        speaking = false;
        setSpeechActive(-1);
        $('watchlistBriefingPause').disabled = true;
        $('watchlistBriefingStop').disabled = true;
        setStatus('Watchlist briefing complete. Source links remain available below.');
      }
      return;
    }
    const segment = speechSegments[index];
    const utterance = new SpeechSynthesisUtterance(segment.text);
    const voice = preferredVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || 'en-US';
    utterance.rate = Number($('watchlistBriefingRate').value || 1);
    utterance.onstart = () => {
      setSpeechActive(index);
      setStatus(index === 0 ? 'Playing watchlist overview.' : `Playing ${segment.title}.`);
    };
    utterance.onend = () => { if (speaking) speak(index + 1); };
    utterance.onerror = (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      speaking = false;
      setStatus(`Audio stopped: ${event.error || 'speech synthesis error'}. The transcript remains available.`, true);
    };
    synth.speak(utterance);
  }

  function play() {
    if (!synth || !speechSegments.length) return;
    synth.cancel();
    speaking = true;
    $('watchlistBriefingPause').disabled = false;
    $('watchlistBriefingStop').disabled = false;
    $('watchlistBriefingPause').textContent = 'Pause';
    speak(0);
  }

  function pauseResume() {
    if (!synth || !speaking) return;
    if (synth.paused) {
      synth.resume();
      $('watchlistBriefingPause').textContent = 'Pause';
      setStatus('Watchlist briefing resumed.');
    } else {
      synth.pause();
      $('watchlistBriefingPause').textContent = 'Resume';
      setStatus('Watchlist briefing paused.');
    }
  }

  function stop() {
    if (!synth) return;
    speaking = false;
    synth.cancel();
    setSpeechActive(-1);
    $('watchlistBriefingPause').disabled = true;
    $('watchlistBriefingStop').disabled = true;
    $('watchlistBriefingPause').textContent = 'Pause';
    if (briefing) setStatus('Watchlist briefing stopped. The generated briefing remains below.');
  }

  async function generate() {
    if (!access.authenticated || !access.allowed) {
      location.href = '/account/';
      return;
    }
    const button = $('watchlistBriefingGenerate');
    button.disabled = true;
    stop();
    try {
      const tickers = await readWatchlist();
      if (!tickers.length) throw new Error('Add at least one ticker first.');
      setStatus(`Verifying Plus access for a ${tickers.length}-ticker briefing…`);
      const token = await capability();
      setStatus(`Loading public market context for ${tickers.length} ticker${tickers.length === 1 ? '' : 's'}…`);
      briefing = await requestBriefing(tickers, token);
      renderBriefing(briefing);
      const partial = briefing.failures?.length ? ` ${briefing.failures.length} ticker${briefing.failures.length === 1 ? '' : 's'} could not be loaded.` : '';
      setStatus(`Briefing ready with ${briefing.highlights?.length || 0} ranked highlights across ${briefing.loadedTickerCount || 0} ticker${briefing.loadedTickerCount === 1 ? '' : 's'}.${partial}`);
    } catch (error) {
      setStatus(`Could not generate watchlist briefing: ${error.message}`, true);
    } finally {
      await renderAccess();
    }
  }

  function init() {
    if (!ensureUi()) return;
    $('watchlistBriefingGenerate').addEventListener('click', generate);
    $('watchlistBriefingPlay').addEventListener('click', play);
    $('watchlistBriefingPause').addEventListener('click', pauseResume);
    $('watchlistBriefingStop').addEventListener('click', stop);
    const watchlist = $('watchlist');
    if (watchlist) new MutationObserver(() => renderAccess()).observe(watchlist, {childList: true, subtree: true});
    window.addEventListener('focus', fetchAccess);
    window.addEventListener('beforeunload', () => { if (speaking) synth?.cancel(); });
    fetchAccess();
  }

  init();
})();

(() => {
  'use strict';

  const synth = window.speechSynthesis;
  const $ = (id) => document.getElementById(id);
  const PRESETS = Object.freeze({
    quick: {label: '3-minute scan', shortLabel: '3 min', maxStories: 3, maxFilings: 1, summaryChars: 170, contextChars: 110},
    standard: {label: '5-minute brief', shortLabel: '5 min', maxStories: 5, maxFilings: 2, summaryChars: 300, contextChars: 170},
    deep: {label: '10-minute deep dive', shortLabel: '10 min', maxStories: 8, maxFilings: 3, summaryChars: 480, contextChars: 260}
  });
  const WORDS_PER_MINUTE = 145;

  let mode = 'standard';
  let segments = [];
  let stopped = true;
  let initialized = false;

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const trim = (value, limit) => {
    const text = clean(value);
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit);
    const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
    return `${cut.slice(0, boundary > limit * 0.6 ? boundary : limit).trim()}…`;
  };
  const safeUrl = (value) => {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  };

  function ensureStyles() {
    if (document.querySelector('link[data-research-radio-style]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './research-radio.css';
    link.dataset.researchRadioStyle = 'true';
    document.head.appendChild(link);
  }

  function ensureUi() {
    const panel = document.querySelector('.briefing-panel');
    const controls = panel?.querySelector('.briefing-controls');
    if (!panel || !controls) return false;
    ensureStyles();

    const eyebrow = panel.querySelector('.briefing-heading .eyebrow');
    const title = $('briefingTitle');
    const kicker = panel.querySelector('.briefing-kicker');
    if (eyebrow) eyebrow.textContent = 'Research Radio';
    if (title) title.textContent = 'Listen to what matters';
    if (kicker) kicker.textContent = 'Choose a listening format. Ticker Watch prioritizes high-impact and directional evidence, keeps source links in the transcript, and uses only research already loaded in this browser.';

    if (!$('radioFormats')) {
      const chooser = document.createElement('div');
      chooser.id = 'radioFormats';
      chooser.className = 'radio-formats';
      chooser.innerHTML = `
        <div class="radio-format-copy">
          <span class="radio-label">Listening format</span>
          <strong id="radioFormatTitle">5-minute brief</strong>
          <small id="radioEstimate">Target format; actual length varies with available evidence and playback speed.</small>
        </div>
        <div class="radio-format-buttons" role="group" aria-label="Research Radio listening format">
          <button type="button" data-radio-mode="quick">3 min<span>Quick scan</span></button>
          <button type="button" data-radio-mode="standard" class="active">5 min<span>Research brief</span></button>
          <button type="button" data-radio-mode="deep">10 min<span>Deep dive</span></button>
          <button type="button" data-radio-mode="changes" class="radio-plus" disabled>Changes only<span>Plus</span></button>
        </div>
        <button id="radioWatchlistJump" class="radio-watchlist-jump" type="button" hidden>Whole-watchlist radio →</button>`;
      controls.insertAdjacentElement('beforebegin', chooser);
    }

    const play = $('briefingPlay');
    if (play) play.textContent = 'Play 5-minute brief';
    return true;
  }

  function badges(card) {
    return Array.from(card.querySelectorAll('.badge')).map((node) => clean(node.textContent));
  }

  function storyPriority(card, index) {
    const values = badges(card).map((value) => value.toLowerCase());
    const impact = values.some((x) => x.includes('high potential impact')) ? 3 : values.some((x) => x.includes('medium potential impact')) ? 2 : 1;
    const direction = values.some((x) => x.includes('possible positive')) || values.some((x) => x.includes('possible negative')) ? 1 : 0;
    return {impact, direction, index};
  }

  function extractStories() {
    return Array.from(document.querySelectorAll('#newsList .feed-card')).map((card, index) => {
      const values = badges(card);
      const reasons = Array.from(card.querySelectorAll('.reason')).map((node) => clean(node.textContent));
      const priority = storyPriority(card, index);
      return {
        kind: 'story',
        title: clean(card.querySelector('h3')?.textContent),
        summary: clean(card.querySelector('p')?.textContent),
        direction: values.find((x) => /possible positive|possible negative|neutral \/ mixed/i.test(x)) || 'Neutral / mixed',
        impact: values.find((x) => /potential impact/i.test(x)) || 'Low potential impact',
        reasons,
        url: safeUrl(card.querySelector('a[href]')?.href),
        priority
      };
    }).filter((item) => item.title)
      .sort((a, b) => b.priority.impact - a.priority.impact || b.priority.direction - a.priority.direction || a.priority.index - b.priority.index);
  }

  function extractFilings() {
    return Array.from(document.querySelectorAll('#filingList .feed-card')).map((card, index) => {
      const values = badges(card);
      const impact = values.find((x) => /potential impact/i.test(x)) || 'Low potential impact';
      return {
        kind: 'filing',
        title: clean(card.querySelector('h3')?.textContent),
        summary: clean(card.querySelector('.reason')?.textContent),
        impact,
        direction: 'Primary source',
        url: safeUrl(card.querySelector('a[href]')?.href),
        priority: {impact: /high/i.test(impact) ? 3 : /medium/i.test(impact) ? 2 : 1, index}
      };
    }).filter((item) => item.title)
      .sort((a, b) => b.priority.impact - a.priority.impact || a.priority.index - b.priority.index);
  }

  function extractChanges() {
    return Array.from(document.querySelectorAll('#sinceList .since-item')).map((card, index) => {
      const meta = Array.from(card.querySelectorAll('.since-item-meta span')).map((node) => clean(node.textContent));
      const kind = meta.some((x) => /SEC filing/i.test(x)) ? 'filing' : 'story';
      const impactText = meta.find((x) => /impact/i.test(x)) || 'low impact';
      const direction = meta.find((x) => /possible positive|possible negative|neutral/i.test(x)) || (kind === 'filing' ? 'Primary source' : 'Neutral / mixed');
      return {
        kind,
        title: clean(card.querySelector('h3')?.textContent),
        summary: clean(card.querySelector('p')?.textContent),
        impact: impactText,
        direction,
        url: safeUrl(card.querySelector('a[href]')?.href),
        priority: {impact: /high/i.test(impactText) ? 3 : /medium/i.test(impactText) ? 2 : 1, direction: /positive|negative/i.test(direction) ? 1 : 0, index}
      };
    }).filter((item) => item.title)
      .sort((a, b) => b.priority.impact - a.priority.impact || (b.priority.direction || 0) - (a.priority.direction || 0) || a.priority.index - b.priority.index);
  }

  function regularSegments(selectedMode) {
    const preset = PRESETS[selectedMode] || PRESETS.standard;
    const ticker = clean($('tickerName')?.textContent) || 'this ticker';
    const company = clean($('companyName')?.textContent) || ticker;
    const price = clean($('lastPrice')?.textContent) || 'unavailable';
    const change = clean($('dayChange')?.textContent) || 'change unavailable';
    const tone = clean($('toneLabel')?.textContent) || 'mixed or neutral';
    const score = clean($('toneScore')?.textContent) || '0';
    const high = clean($('toneHigh')?.textContent) || '0';
    const stories = extractStories().slice(0, preset.maxStories);
    const filings = extractFilings().slice(0, preset.maxFilings);
    if (!stories.length && !filings.length) return [];

    const result = [{
      kind: 'intro', title: `${ticker} ${preset.label}`,
      text: `Welcome to ShareCapsule Research Radio for ${company}, ticker ${ticker}. The latest displayed price is ${price}, with ${change}. Recent coverage is labeled ${tone}, with a tone index of ${score} and ${high} high-impact stories in the current research view. This ${preset.label} prioritizes the evidence most worth reviewing.`, url: ''
    }];

    stories.forEach((story, index) => {
      const context = story.reasons.map((reason) => reason.replace(/^Direction context:\s*/i, '').replace(/^Why flagged:\s*/i, '')).filter(Boolean).join(' ');
      const detail = trim(story.summary || context, preset.summaryChars);
      const why = story.summary && context ? ` Why it may matter: ${trim(context, preset.contextChars)}` : '';
      result.push({
        kind: 'story', title: story.title, direction: story.direction, impact: story.impact, url: story.url,
        text: `Story ${index + 1}. ${story.title}. This is labeled ${story.direction.toLowerCase()} and ${story.impact.toLowerCase()}. ${detail}${why}`
      });
    });

    filings.forEach((filing, index) => {
      result.push({
        kind: 'filing', title: filing.title, direction: 'SEC filing', impact: filing.impact, url: filing.url,
        text: `SEC filing ${index + 1}. ${filing.title}. This is a primary-source regulatory filing labeled ${filing.impact.toLowerCase()} for research prioritization. ${trim(filing.summary, preset.contextChars)} Review the filing itself before drawing a conclusion.`
      });
    });

    result.push({
      kind: 'closing', title: 'Research Radio complete', url: '',
      text: `That concludes the ${preset.label} for ${ticker}. News direction and impact labels organize research; they do not predict price movement or recommend a trade. Open the linked original sources in the transcript to verify anything material.`
    });
    return result;
  }

  function changesSegments() {
    const ticker = clean($('tickerName')?.textContent) || 'this ticker';
    const changes = extractChanges();
    if (!changes.length) return [];
    const storyCount = changes.filter((item) => item.kind === 'story').length;
    const filingCount = changes.filter((item) => item.kind === 'filing').length;
    const result = [{
      kind: 'intro', title: `${ticker} changes-only catch-up`, url: '',
      text: `Here is your ShareCapsule Research Radio changes-only catch-up for ${ticker}. Since the previous encrypted checkpoint on this device, the current research memory shows ${storyCount} newly surfaced ${storyCount === 1 ? 'story' : 'stories'} and ${filingCount} new SEC ${filingCount === 1 ? 'filing' : 'filings'}. Here is what changed.`
    }];
    changes.slice(0, 8).forEach((item, index) => {
      result.push({
        kind: item.kind, title: item.title, direction: item.direction, impact: item.impact, url: item.url,
        text: `Change ${index + 1}. ${item.title}. ${item.kind === 'filing' ? 'This is a newly surfaced SEC filing.' : `This item is labeled ${item.direction.toLowerCase()} and ${item.impact.toLowerCase()}.`} ${trim(item.summary, 330)}`
      });
    });
    result.push({
      kind: 'closing', title: 'Changes catch-up complete', url: '',
      text: `You are caught up on the newly surfaced evidence currently shown for ${ticker}. This research memory is a prioritization aid, not a price forecast or trade recommendation. Verify material information at the original source.`
    });
    return result;
  }

  function buildSegments() {
    return mode === 'changes' ? changesSegments() : regularSegments(mode);
  }

  function runtimeText(items) {
    const words = items.reduce((total, item) => total + clean(item.text).split(/\s+/).filter(Boolean).length, 0);
    const rate = Math.max(0.5, Number($('briefingRate')?.value || 1));
    const minutes = words / (WORDS_PER_MINUTE * rate);
    if (!words) return 'No playable evidence is available for this format yet.';
    if (minutes < 1) return `About ${Math.max(20, Math.round(minutes * 60))} sec of current material at ${rate.toFixed(rate % 1 ? 1 : 0)}×.`;
    return `About ${minutes.toFixed(minutes < 3 ? 1 : 0)} min of current material at ${rate.toFixed(rate % 1 ? 1 : 0)}×. Target formats expand only when enough sourced evidence is available.`;
  }

  function renderTranscript() {
    const list = $('briefingTranscript');
    if (!list) return;
    list.innerHTML = '';
    const summary = document.createElement('div');
    summary.className = 'radio-transcript-summary';
    summary.innerHTML = `<strong>${esc(mode === 'changes' ? 'Changes-only catch-up' : (PRESETS[mode]?.label || 'Research brief'))}</strong><span>${esc(runtimeText(segments))}</span>`;
    list.appendChild(summary);
    segments.forEach((segment, index) => {
      const article = document.createElement('article');
      article.className = 'briefing-item radio-item';
      article.dataset.briefingIndex = String(index);
      const meta = ['story','filing'].includes(segment.kind)
        ? `<div class="briefing-meta"><span>${esc(segment.direction || segment.kind)}</span><span>${esc(segment.impact || '')}</span></div>` : '';
      const link = segment.url ? `<a href="${esc(segment.url)}" target="_blank" rel="noopener noreferrer">Open original source ↗</a>` : '';
      article.innerHTML = `${meta}<h3>${esc(segment.title)}</h3><p>${esc(segment.text)}</p>${link}`;
      list.appendChild(article);
    });
  }

  function setStatus(message) {
    if ($('briefingStatus')) $('briefingStatus').textContent = message;
  }

  function setActive(index) {
    document.querySelectorAll('[data-briefing-index]').forEach((node) => node.classList.toggle('active', Number(node.dataset.briefingIndex) === index));
    const active = document.querySelector(`[data-briefing-index="${index}"]`);
    active?.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    if ($('briefingProgress')) $('briefingProgress').textContent = segments.length && index >= 0 ? `${index + 1} / ${segments.length}` : `0 / ${segments.length}`;
  }

  function selectedVoice() {
    const uri = $('briefingVoice')?.value;
    const voices = synth?.getVoices?.() || [];
    if (uri) return voices.find((voice) => voice.voiceURI === uri) || null;
    return voices.find((voice) => /^en(-|_)/i.test(voice.lang) && voice.localService && voice.default)
      || voices.find((voice) => /^en(-|_)/i.test(voice.lang) && voice.localService)
      || null;
  }

  function speakIndex(index) {
    if (!synth || stopped || index >= segments.length) {
      if (index >= segments.length) {
        stopped = true;
        setActive(-1);
        setStatus('Research Radio complete. Use the transcript links to read any source in full.');
        if ($('briefingPause')) $('briefingPause').disabled = true;
        if ($('briefingStop')) $('briefingStop').disabled = true;
      }
      return;
    }
    const segment = segments[index];
    const utterance = new SpeechSynthesisUtterance(segment.text);
    const voice = selectedVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || 'en-US';
    utterance.rate = Number($('briefingRate')?.value || 1);
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.onstart = () => {
      setActive(index);
      setStatus(segment.kind === 'story' || segment.kind === 'filing' ? `Playing research item ${index} of ${Math.max(1, segments.length - 2)}.` : segment.title);
    };
    utterance.onend = () => { if (!stopped) speakIndex(index + 1); };
    utterance.onerror = (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      stopped = true;
      setStatus(`Research Radio could not continue: ${event.error || 'speech synthesis error'}. The transcript remains available.`);
    };
    synth.speak(utterance);
  }

  function prepareAndPlay(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    segments = buildSegments();
    renderTranscript();
    updateEstimate(segments);
    if (!segments.length) {
      stopped = true;
      if (mode === 'changes') return setStatus('No newly surfaced evidence is available in “Since I last checked” yet. Refresh after a later market update, or choose a 3 / 5 / 10-minute format.');
      return setStatus('Load ticker news or SEC filings first, then start Research Radio.');
    }
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      stopped = true;
      return setStatus('This browser does not expose speech synthesis. The Research Radio transcript is available below.');
    }
    synth.cancel();
    stopped = false;
    if ($('briefingPause')) { $('briefingPause').disabled = false; $('briefingPause').textContent = 'Pause'; }
    if ($('briefingStop')) $('briefingStop').disabled = false;
    speakIndex(0);
  }

  function pauseResume(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    if (!synth || stopped) return;
    if (synth.paused) {
      synth.resume();
      $('briefingPause').textContent = 'Pause';
      setStatus('Research Radio resumed.');
    } else {
      synth.pause();
      $('briefingPause').textContent = 'Resume';
      setStatus('Research Radio paused.');
    }
  }

  function stop(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    stopped = true;
    synth?.cancel();
    setActive(-1);
    if ($('briefingPause')) { $('briefingPause').textContent = 'Pause'; $('briefingPause').disabled = true; }
    if ($('briefingStop')) $('briefingStop').disabled = true;
    setStatus('Research Radio stopped. The transcript remains available.');
  }

  function updateEstimate(prebuilt) {
    const target = $('radioEstimate');
    if (!target) return;
    const items = prebuilt || buildSegments();
    target.textContent = runtimeText(items);
  }

  function refreshModeAvailability() {
    if (!ensureUi()) return;
    const changes = extractChanges();
    const changesButton = document.querySelector('[data-radio-mode="changes"]');
    if (changesButton) {
      changesButton.disabled = changes.length === 0;
      changesButton.title = changes.length ? `${changes.length} newly surfaced item${changes.length === 1 ? '' : 's'} ready to hear` : 'Available when Plus research memory detects newly surfaced evidence';
    }
    const watchlist = document.querySelector('.watchlist-briefing-panel');
    const jump = $('radioWatchlistJump');
    if (jump) jump.hidden = !watchlist;
    if (mode === 'changes' && !changes.length) selectMode('standard');
  }

  function selectMode(nextMode) {
    if (nextMode === 'changes' && !extractChanges().length) return;
    if (!PRESETS[nextMode] && nextMode !== 'changes') return;
    mode = nextMode;
    document.querySelectorAll('[data-radio-mode]').forEach((button) => button.classList.toggle('active', button.dataset.radioMode === mode));
    const title = $('radioFormatTitle');
    if (title) title.textContent = mode === 'changes' ? 'Changes-only catch-up' : PRESETS[mode].label;
    const play = $('briefingPlay');
    if (play) play.textContent = mode === 'changes' ? 'Play latest changes' : `Play ${PRESETS[mode].shortLabel} ${mode === 'quick' ? 'scan' : mode === 'deep' ? 'deep dive' : 'brief'}`;
    updateEstimate();
    if (stopped) setStatus(mode === 'changes' ? 'Changes-only mode speaks only the newly surfaced evidence currently shown by Plus research memory.' : `${PRESETS[mode].label} selected. Research Radio will prioritize the strongest currently displayed evidence.`);
  }

  function bind() {
    if (initialized || !ensureUi()) return;
    initialized = true;
    document.querySelectorAll('[data-radio-mode]').forEach((button) => button.addEventListener('click', () => selectMode(button.dataset.radioMode)));
    $('briefingPlay')?.addEventListener('click', prepareAndPlay, true);
    $('briefingPause')?.addEventListener('click', pauseResume, true);
    $('briefingStop')?.addEventListener('click', stop, true);
    $('briefingRate')?.addEventListener('change', () => updateEstimate());
    $('radioWatchlistJump')?.addEventListener('click', () => document.querySelector('.watchlist-briefing-panel')?.scrollIntoView({behavior: 'smooth', block: 'start'}));

    const detail = $('detail');
    if (detail) new MutationObserver(() => {
      refreshModeAvailability();
      if (stopped) updateEstimate();
    }).observe(detail, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden']});

    window.addEventListener('beforeunload', () => synth?.cancel());
    refreshModeAvailability();
    selectMode('standard');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, {once: true});
  else bind();
})();

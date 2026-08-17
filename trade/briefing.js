(() => {
  'use strict';

  const synth = window.speechSynthesis;
  const $ = (id) => document.getElementById(id);
  const MAX_STORIES = 6;
  let segments = [];
  let activeIndex = -1;
  let currentUtterance = null;
  let stopped = true;
  let voices = [];

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const trim = (value, limit) => {
    const text = clean(value);
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit);
    const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
    return `${cut.slice(0, boundary > limit * 0.6 ? boundary : limit).trim()}…`;
  };

  function storyPriority(card, index) {
    const badges = Array.from(card.querySelectorAll('.badge')).map((node) => clean(node.textContent).toLowerCase());
    const impact = badges.some((x) => x.includes('high potential impact')) ? 3 : badges.some((x) => x.includes('medium potential impact')) ? 2 : 1;
    const direction = badges.some((x) => x.includes('possible positive')) || badges.some((x) => x.includes('possible negative')) ? 1 : 0;
    return { impact, direction, index };
  }

  function extractStories() {
    return Array.from(document.querySelectorAll('#newsList .feed-card')).map((card, index) => {
      const badges = Array.from(card.querySelectorAll('.badge')).map((node) => clean(node.textContent));
      const reasons = Array.from(card.querySelectorAll('.reason')).map((node) => clean(node.textContent));
      const link = card.querySelector('a[href]');
      const priority = storyPriority(card, index);
      const direction = badges.find((x) => /possible positive|possible negative|neutral \/ mixed/i.test(x)) || 'Neutral / mixed';
      const impact = badges.find((x) => /potential impact/i.test(x)) || 'Low potential impact';
      return {
        title: clean(card.querySelector('h3')?.textContent),
        summary: clean(card.querySelector('p')?.textContent),
        direction,
        impact,
        reasons,
        url: link?.href || '',
        priority
      };
    }).filter((item) => item.title)
      .sort((a, b) => b.priority.impact - a.priority.impact || b.priority.direction - a.priority.direction || a.priority.index - b.priority.index)
      .slice(0, MAX_STORIES);
  }

  function buildSegments() {
    const ticker = clean($('tickerName')?.textContent) || 'this ticker';
    const company = clean($('companyName')?.textContent) || ticker;
    const price = clean($('lastPrice')?.textContent);
    const change = clean($('dayChange')?.textContent);
    const tone = clean($('toneLabel')?.textContent) || 'mixed or neutral';
    const score = clean($('toneScore')?.textContent) || '0';
    const positive = clean($('tonePositive')?.textContent) || '0';
    const negative = clean($('toneNegative')?.textContent) || '0';
    const high = clean($('toneHigh')?.textContent) || '0';
    const stories = extractStories();
    if (!stories.length) return [];

    const result = [{
      kind: 'intro',
      title: `${ticker} audio briefing`,
      text: `Here is your ShareCapsule Finance briefing for ${company}, ticker ${ticker}. The latest displayed price is ${price}, with ${change}. Recent news tone is ${tone}, with a tone index of ${score}. The page currently shows ${positive} potentially positive stories, ${negative} potentially negative stories, and ${high} high-impact stories. Here are the highlights most worth reviewing.`,
      url: ''
    }];

    stories.forEach((story, index) => {
      const direction = story.direction.toLowerCase().replace('possible ', 'potentially ');
      const impact = story.impact.toLowerCase().replace(' potential impact', '-impact');
      const context = story.reasons.map((reason) => reason.replace(/^Direction context:\s*/i, '').replace(/^Why flagged:\s*/i, '')).filter(Boolean).join(' ');
      const detail = trim(story.summary || context, 320);
      const why = story.summary && context ? ` Why it may matter: ${trim(context, 190)}` : '';
      result.push({
        kind: 'story',
        title: story.title,
        direction: story.direction,
        impact: story.impact,
        text: `Story ${index + 1}. This is labeled ${direction} and ${impact}. ${story.title}. ${detail}${why}`,
        url: story.url
      });
    });

    result.push({
      kind: 'closing',
      title: 'Briefing complete',
      text: `That concludes the current ${ticker} briefing. These labels summarize recent coverage and event significance; they do not predict the stock price. Use the article links in the transcript to read any story in full and verify important details at the original source.`,
      url: ''
    });
    return result;
  }

  function renderTranscript() {
    const list = $('briefingTranscript');
    if (!list) return;
    list.innerHTML = '';
    segments.forEach((segment, index) => {
      const article = document.createElement('article');
      article.className = 'briefing-item';
      article.dataset.briefingIndex = String(index);
      const meta = segment.kind === 'story'
        ? `<div class="briefing-meta"><span>${escapeHtml(segment.direction)}</span><span>${escapeHtml(segment.impact)}</span></div>`
        : '';
      const link = segment.url
        ? `<a href="${escapeHtml(segment.url)}" target="_blank" rel="noopener noreferrer">Read full article ↗</a>`
        : '';
      article.innerHTML = `${meta}<h3>${escapeHtml(segment.title)}</h3><p>${escapeHtml(segment.text)}</p>${link}`;
      list.appendChild(article);
    });
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function setStatus(message) {
    if ($('briefingStatus')) $('briefingStatus').textContent = message;
  }

  function setActive(index) {
    activeIndex = index;
    document.querySelectorAll('[data-briefing-index]').forEach((node) => node.classList.toggle('active', Number(node.dataset.briefingIndex) === index));
    const active = document.querySelector(`[data-briefing-index="${index}"]`);
    active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if ($('briefingProgress')) $('briefingProgress').textContent = segments.length ? `${Math.min(index + 1, segments.length)} / ${segments.length}` : '0 / 0';
  }

  function populateVoices() {
    if (!synth || !$('briefingVoice')) return;
    voices = synth.getVoices();
    const english = voices.filter((voice) => /^en(-|_)/i.test(voice.lang));
    const local = english.filter((voice) => voice.localService);
    const select = $('briefingVoice');
    const previous = select.value;
    select.replaceChildren();
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = local.length ? 'Automatic local voice' : 'Browser default voice';
    select.appendChild(defaultOption);
    local.forEach((voice) => {
      const option = document.createElement('option');
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} · ${voice.lang} · local`;
      select.appendChild(option);
    });
    if (previous && Array.from(select.options).some((option) => option.value === previous)) select.value = previous;
    $('briefingVoiceNote').textContent = local.length
      ? `${local.length} local English voice${local.length === 1 ? '' : 's'} available. ShareCapsule prefers local speech synthesis.`
      : 'No local English voice was reported by this browser. Its default speech service may be local or remote.';
  }

  function selectedVoice() {
    const selectedUri = $('briefingVoice')?.value;
    if (selectedUri) return voices.find((voice) => voice.voiceURI === selectedUri) || null;
    return voices.find((voice) => /^en(-|_)/i.test(voice.lang) && voice.localService && voice.default)
      || voices.find((voice) => /^en(-|_)/i.test(voice.lang) && voice.localService)
      || null;
  }

  function speakIndex(index) {
    if (!synth || stopped || index >= segments.length) {
      if (index >= segments.length) {
        stopped = true;
        setActive(-1);
        setStatus('Briefing complete. Open any transcript item to read the full source article.');
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
      setStatus(segment.kind === 'story' ? `Playing highlight ${index} of ${Math.max(1, segments.length - 2)}.` : segment.title);
    };
    utterance.onend = () => {
      currentUtterance = null;
      if (!stopped) speakIndex(index + 1);
    };
    utterance.onerror = (event) => {
      currentUtterance = null;
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      stopped = true;
      setStatus(`Audio could not continue: ${event.error || 'speech synthesis error'}. The transcript is still available below.`);
    };
    currentUtterance = utterance;
    synth.speak(utterance);
  }

  function prepareAndPlay() {
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      setStatus('This browser does not expose speech synthesis. You can still use the generated transcript.');
      segments = buildSegments();
      renderTranscript();
      return;
    }
    synth.cancel();
    stopped = false;
    segments = buildSegments();
    renderTranscript();
    if (!segments.length) {
      stopped = true;
      return setStatus('Load ticker news first, then generate the audio briefing.');
    }
    $('briefingPause').disabled = false;
    $('briefingStop').disabled = false;
    speakIndex(0);
  }

  function pauseResume() {
    if (!synth || stopped) return;
    if (synth.paused) {
      synth.resume();
      $('briefingPause').textContent = 'Pause';
      setStatus('Briefing resumed.');
    } else {
      synth.pause();
      $('briefingPause').textContent = 'Resume';
      setStatus('Briefing paused.');
    }
  }

  function stop() {
    stopped = true;
    currentUtterance = null;
    synth?.cancel();
    setActive(-1);
    $('briefingPause').textContent = 'Pause';
    $('briefingPause').disabled = true;
    $('briefingStop').disabled = true;
    setStatus('Briefing stopped. The transcript remains available.');
  }

  function refreshAvailability() {
    const count = document.querySelectorAll('#newsList .feed-card').length;
    const button = $('briefingPlay');
    if (button) button.disabled = count === 0;
    if (count === 0) {
      stop();
      segments = [];
      if ($('briefingTranscript')) $('briefingTranscript').innerHTML = '<div class="briefing-empty">Load a ticker to create a personalized audio briefing.</div>';
      setStatus('Waiting for ticker news.');
    } else if (stopped) {
      setStatus(`${count} recent stor${count === 1 ? 'y is' : 'ies are'} ready for a personalized briefing.`);
    }
  }

  function init() {
    if (!$('briefingPlay')) return;
    $('briefingPlay').addEventListener('click', prepareAndPlay);
    $('briefingPause').addEventListener('click', pauseResume);
    $('briefingStop').addEventListener('click', stop);
    $('briefingRate').addEventListener('change', () => {
      if (!stopped && synth?.speaking) setStatus('Playback speed will apply to the next briefing segment.');
    });
    populateVoices();
    if (synth) synth.addEventListener?.('voiceschanged', populateVoices);
    const newsList = $('newsList');
    if (newsList) new MutationObserver(() => {
      if (!stopped) stop();
      refreshAvailability();
    }).observe(newsList, { childList: true, subtree: true });
    window.addEventListener('beforeunload', () => synth?.cancel());
    refreshAvailability();
  }

  init();
})();

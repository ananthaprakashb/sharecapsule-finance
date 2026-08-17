(() => {
  'use strict';

  const STORAGE_KEY = 'sharecapsule-ticker-sync-expanded';

  function readPreference() {
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; }
    catch { return false; }
  }

  function rememberPreference(expanded) {
    try { localStorage.setItem(STORAGE_KEY, String(expanded)); }
    catch { /* Collapsing still works when storage is unavailable. */ }
  }

  function ensureStylesheet() {
    if (document.querySelector('link[data-sync-collapse-style]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './sync-collapse.css';
    link.dataset.syncCollapseStyle = 'true';
    document.head.appendChild(link);
  }

  function init() {
    const panel = document.querySelector('.sync-panel');
    const heading = panel?.querySelector('.sync-heading');
    if (!panel || !heading || document.getElementById('syncCollapseButton')) return;

    ensureStylesheet();

    const body = document.createElement('div');
    body.id = 'syncCollapsibleBody';
    body.className = 'sync-collapsible-body';

    Array.from(panel.children).forEach((node) => {
      if (node !== heading) body.appendChild(node);
    });
    panel.appendChild(body);

    const state = document.getElementById('syncState');
    const controls = document.createElement('div');
    controls.className = 'sync-heading-controls';
    if (state) controls.appendChild(state);

    const toggle = document.createElement('button');
    toggle.id = 'syncCollapseButton';
    toggle.className = 'sync-collapse-button';
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', body.id);
    controls.appendChild(toggle);
    heading.appendChild(controls);

    let expanded = readPreference();

    function setExpanded(next, {remember = true} = {}) {
      expanded = Boolean(next);
      panel.classList.toggle('sync-collapsed', !expanded);
      body.hidden = !expanded;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', expanded ? 'Collapse encrypted watchlist sync settings' : 'Expand encrypted watchlist sync settings');
      toggle.innerHTML = `<span>${expanded ? 'Hide sync' : 'Sync settings'}</span><span class="sync-chevron" aria-hidden="true">${expanded ? '⌃' : '⌄'}</span>`;
      if (remember) rememberPreference(expanded);
    }

    toggle.addEventListener('click', () => setExpanded(!expanded));

    const pairPanel = document.getElementById('syncPairPanel');
    const conflictPanel = document.getElementById('syncConflict');
    const message = document.getElementById('syncMessage');

    function needsAttention() {
      return Boolean(
        (pairPanel && !pairPanel.hidden) ||
        (conflictPanel && !conflictPanel.hidden) ||
        message?.classList.contains('error')
      );
    }

    const observer = new MutationObserver(() => {
      if (needsAttention()) setExpanded(true, {remember: false});
    });

    if (pairPanel) observer.observe(pairPanel, {attributes: true, attributeFilter: ['hidden']});
    if (conflictPanel) observer.observe(conflictPanel, {attributes: true, attributeFilter: ['hidden']});
    if (message) observer.observe(message, {attributes: true, attributeFilter: ['class']});

    setExpanded(needsAttention() ? true : expanded, {remember: false});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true});
  else init();
})();

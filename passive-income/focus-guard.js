(() => {
  'use strict';

  function hasActiveProject() {
    return [...document.querySelectorAll('#projectPortfolio .status')].some((node) => node.textContent.trim().toLowerCase() === 'active');
  }

  function enforceSingleFocus() {
    const active = hasActiveProject();
    document.querySelectorAll('[data-start-idea]').forEach((button) => {
      if (active) {
        button.disabled = true;
        button.textContent = 'Finish current focus first';
      }
    });
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-start-idea]');
    if (!button || !hasActiveProject()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    alert('One project is already active. Open that project, complete it, then choose the next idea.');
  }, true);

  const observer = new MutationObserver(enforceSingleFocus);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', enforceSingleFocus);
})();
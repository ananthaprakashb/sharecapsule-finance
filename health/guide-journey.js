(() => {
  'use strict';

  const STORAGE_KEY = 'sharecapsule-finance-guide-focus-v1';
  const ALLOWED_GUIDES = new Map([
    ['/guide/expenses.html', 'Income & expenses'],
    ['/guide/credit-cards.html', 'Credit cards & debt'],
    ['/guide/emergency-fund.html', 'Emergency reserves'],
    ['/guide/investing.html', 'Investment categories'],
    ['/guide/retirement.html', 'Retirement'],
    ['/guide/protection.html', 'Insurance & risk'],
    ['/guide/review.html', 'Monthly control review']
  ]);

  function normalizePath(href) {
    try {
      return new URL(href, window.location.origin).pathname;
    } catch (_) {
      return '';
    }
  }

  function findReason(link) {
    const card = link.closest('.action-card');
    if (!card) return '';
    const paragraphs = [...card.querySelectorAll('p')]
      .filter((node) => !node.classList.contains('eyebrow'))
      .map((node) => node.textContent.trim())
      .filter(Boolean);
    return paragraphs[0] || '';
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;

    const targetPath = normalizePath(link.getAttribute('href'));
    const guideTitle = ALLOWED_GUIDES.get(targetPath);
    if (!guideTitle) return;

    const isHealthRecommendation = Boolean(link.closest('#recommendedGuidesPanel') || link.closest('#actionList'));
    if (!isHealthRecommendation) return;

    event.preventDefault();

    const payload = {
      version: 1,
      targetPath,
      guideTitle,
      reason: findReason(link),
      healthScore: document.getElementById('healthScore')?.textContent?.trim() || '',
      healthLabel: document.getElementById('healthLabel')?.textContent?.trim() || '',
      createdAt: Date.now()
    };

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {
      // If session storage is unavailable, fall back to the static guide.
      window.location.assign(targetPath);
      return;
    }

    window.location.assign('/guide/focus/');
  });
})();

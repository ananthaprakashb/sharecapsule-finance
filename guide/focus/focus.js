(() => {
  'use strict';

  const STORAGE_KEY = 'sharecapsule-finance-guide-focus-v1';
  const MAX_AGE_MS = 2 * 60 * 60 * 1000;

  const PATHS = {
    '/guide/expenses.html': {
      title: 'Income & expenses',
      steps: [
        ['Measure the real baseline', 'Use the recent transaction history to identify the largest recurring and flexible categories before setting a target.'],
        ['Separate fixed from flexible', 'Mark which costs can change this month and which need a renewal, refinance, relocation or other structural decision.'],
        ['Pick one or two high-impact categories', 'Work first on the categories that are both large and realistically adjustable instead of trying to cut everything at once.'],
        ['Protect the monthly margin', 'Assign any recovered cash flow to reserves, high-cost debt, goals or investing before lifestyle spending expands again.'],
        ['Re-run Financial Health', 'After a month of changes, compare the new spending mix and cash-flow margin with the prior result.']
      ]
    },
    '/guide/credit-cards.html': {
      title: 'Credit cards & debt',
      steps: [
        ['Prevent missed payments', 'Confirm every required minimum payment is covered on time before optimizing payoff strategy.'],
        ['Rank balances by APR', 'List revolving balances from highest APR to lowest so the costliest debt is visible.'],
        ['Use an avalanche payoff order', 'Keep minimums on all debts and direct additional available cash toward the highest APR balance first.'],
        ['Avoid new revolving balances', 'Rewards and utilization tactics should not come ahead of stopping new interest-bearing debt.'],
        ['Recheck after each payoff milestone', 'As a balance is eliminated, redirect the released payment to the next priority instead of absorbing it into spending.']
      ]
    },
    '/guide/emergency-fund.html': {
      title: 'Emergency reserves',
      steps: [
        ['Calculate essential monthly spending', 'Use housing, utilities, food, transportation, insurance, healthcare and required debt payments as the reserve baseline.'],
        ['Reach the first liquidity checkpoint', 'Aim first for a practical starter reserve, then work toward roughly three months when your household circumstances support it.'],
        ['Automate the contribution', 'Treat reserve funding as a recurring transfer rather than whatever remains at the end of the month.'],
        ['Keep predictable costs separate', 'Use sinking funds for annual bills, travel, maintenance and other known expenses so the emergency reserve stays available for true shocks.'],
        ['Increase the target when risk is higher', 'Single-income, variable-income, specialized-role or caregiving households may need a larger cushion.']
      ]
    },
    '/guide/investing.html': {
      title: 'Investment categories',
      steps: [
        ['Confirm the foundation first', 'Make sure high-cost revolving debt and basic liquidity are not being ignored to invest more.'],
        ['Name the goal and time horizon', 'Money needed soon should not be managed like money intended for a decade or more.'],
        ['Choose a diversified core', 'Favor broad diversification before adding concentrated, thematic or speculative positions.'],
        ['Automate sustainable contributions', 'Use an amount that can continue through ordinary market volatility and normal household expenses.'],
        ['Review allocation, not headlines', 'Rebalance when the portfolio drifts materially rather than reacting to short-term market narratives.']
      ]
    },
    '/guide/retirement.html': {
      title: 'Retirement',
      steps: [
        ['Capture available employer benefits', 'Verify whether an employer match is available and whether current contributions are sufficient to receive it.'],
        ['Check the contribution ladder', 'Balance retirement saving with expensive revolving debt and the need for a basic emergency reserve.'],
        ['Increase the savings rate deliberately', 'Automate a sustainable contribution and consider directing part of future raises to retirement.'],
        ['Use account types intentionally', 'Review workplace plans and IRA options in light of eligibility, tax treatment, fees and investment choices.'],
        ['Review annually', 'Contribution limits, household income and tax circumstances change, so recheck the plan each year.']
      ]
    },
    '/guide/protection.html': {
      title: 'Insurance & risk',
      steps: [
        ['Identify catastrophic exposures', 'Focus first on losses that could permanently damage the household plan, not every small expense.'],
        ['Review health-plan total cost', 'Look at premiums, deductibles, out-of-pocket exposure and network access together.'],
        ['Protect household income', 'Consider whether disability and life coverage fit current dependents, debts and future obligations.'],
        ['Check liability protection', 'Review auto, home or renters liability and whether an umbrella layer is appropriate for the household exposure.'],
        ['Revisit after life changes', 'A new home, child, job, income level or health circumstance can change what adequate protection means.']
      ]
    },
    '/guide/review.html': {
      title: 'Monthly control review',
      steps: [
        ['Review income and cash', 'Confirm what came in, current liquidity and whether the month ended with a surplus or deficit.'],
        ['Review the largest expense changes', 'Compare category trends rather than focusing only on small isolated purchases.'],
        ['Check debt and credit', 'Review APR, balances, required payments and any new revolving debt.'],
        ['Check reserves and goals', 'Confirm emergency savings and named goals are progressing at the intended pace.'],
        ['Choose only a few next actions', 'End the review with one to three concrete changes that can actually be completed before the next review.']
      ]
    }
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }

  function loadContext() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !PATHS[parsed.targetPath]) return null;
      if (!Number.isFinite(parsed.createdAt) || Date.now() - parsed.createdAt > MAX_AGE_MS) {
        sessionStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function render(context) {
    const definition = PATHS[context.targetPath];
    $('focusTitle').textContent = `Focus on ${definition.title}`;
    $('guideName').textContent = definition.title;
    $('focusReason').textContent = context.reason || 'This guide was selected because it matches one of the higher-priority signals in your recent Financial Health analysis.';
    $('scoreValue').textContent = context.healthScore || '—';
    $('scoreLabel').textContent = context.healthLabel || 'Financial Health result';
    $('openGuide').href = context.targetPath;
    $('openGuide').textContent = `Open ${definition.title} guide`;
    $('focusSteps').innerHTML = definition.steps.map((step, index) => `<div class="step"><div class="step-num">${index + 1}</div><div><strong>${escapeHtml(step[0])}</strong><p>${escapeHtml(step[1])}</p></div></div>`).join('');
    $('focusContent').hidden = false;
    $('emptyState').hidden = true;
  }

  function init() {
    const context = loadContext();
    if (!context) {
      $('emptyState').hidden = false;
      return;
    }

    render(context);
    $('clearFocus').addEventListener('click', () => {
      sessionStorage.removeItem(STORAGE_KEY);
      $('focusContent').hidden = true;
      $('emptyState').hidden = false;
    });
  }

  init();
})();

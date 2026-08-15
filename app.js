(() => {
  'use strict';

  const DB_NAME = 'sharecapsule-private-finance';
  const DB_VERSION = 1;
  const STORE_NAME = 'vaults';
  const VAULT_ID = 'primary';
  const MIGRATION_PENDING_ID = 'migration-pending';
  const PORTABLE_EXPORT_FORMAT = 'sharecapsule-finance-export-v2';
  const INCOME_DB_NAME = 'sharecapsule-income-projects';
  const INCOME_DB_VERSION = 1;
  const INCOME_STORE = 'workspace';
  const INCOME_STATE_ID = 'state';
  const INCOME_KEY_ID = 'device-key';
  const KDF_ITERATIONS = 600000;
  const AUTO_LOCK_MS = 10 * 60 * 1000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let db;
  let vaultRecord;
  let currentKey = null;
  let state = null;
  let saveTimer = null;
  let lockTimer = null;
  let dirty = false;

  const $ = (id) => document.getElementById(id);
  const qsa = (selector) => [...document.querySelectorAll(selector)];
  const vaultSession = () => window.ShareCapsuleVaultSession || null;
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const money2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });

  const defaultState = () => ({
    version: 1,
    createdAt: new Date().toISOString(),
    settings: { emergencyFundTargetMonths: 6 },
    transactions: [],
    budgets: [],
    accounts: [],
    debts: [],
    goals: []
  });

  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const nowIsoDate = () => new Date().toISOString().slice(0, 10);
  const currentMonthKey = () => new Date().toISOString().slice(0, 7);
  const categoryKey = (value) => String(value || '').trim().toLowerCase();

  function bytesToBase64(bytes) {
    let binary = '';
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dbGet(id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function dbPut(record) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function dbDelete(id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function deriveKeyMaterial(passphrase, salt, iterations = KDF_ITERATIONS) {
    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, baseKey, 256);
    const rawKey = new Uint8Array(bits);
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return { key, rawKey };
  }

  async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS) {
    const material = await deriveKeyMaterial(passphrase, salt, iterations);
    material.rawKey.fill(0);
    return material.key;
  }

  async function encryptState(data, key, salt) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return {
      id: VAULT_ID,
      format: 'sharecapsule-private-finance-v1',
      version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS },
      cipher: { name: 'AES-GCM', length: 256 },
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
      updatedAt: new Date().toISOString()
    };
  }

  async function decryptRecord(record, passphrase) {
    const salt = base64ToBytes(record.salt);
    const iterations = Number(record.kdf?.iterations || KDF_ITERATIONS);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 5000000) throw new Error('Unsupported vault parameters');
    const material = await deriveKeyMaterial(passphrase, salt, iterations);
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv) }, material.key, base64ToBytes(record.ciphertext));
      const parsed = JSON.parse(decoder.decode(plaintext));
      return { key: material.key, rawKey: material.rawKey, state: normalizeState(parsed), salt };
    } catch (error) {
      material.rawKey.fill(0);
      throw error;
    }
  }

  async function decryptRecordWithCurrentKey(record) {
    if (!currentKey) throw new Error('Vault is locked');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv) }, currentKey, base64ToBytes(record.ciphertext));
    return normalizeState(JSON.parse(decoder.decode(plaintext)));
  }

  function normalizeState(value) {
    const base = defaultState();
    if (!value || typeof value !== 'object') return base;
    return {
      version: 1,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : base.createdAt,
      settings: { emergencyFundTargetMonths: clamp(num(value.settings?.emergencyFundTargetMonths) || 6, 1, 24) },
      transactions: Array.isArray(value.transactions) ? value.transactions.slice(0, 10000) : [],
      budgets: Array.isArray(value.budgets) ? value.budgets.slice(0, 200) : [],
      accounts: Array.isArray(value.accounts) ? value.accounts.slice(0, 200) : [],
      debts: Array.isArray(value.debts) ? value.debts.slice(0, 200) : [],
      goals: Array.isArray(value.goals) ? value.goals.slice(0, 200) : []
    };
  }

  async function persist() {
    if (!state || !currentKey || !vaultRecord) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    setSaveState('Encrypting…');
    try {
      const salt = base64ToBytes(vaultRecord.salt);
      vaultRecord = await encryptState(state, currentKey, salt);
      await dbPut(vaultRecord);
      dirty = false;
      setSaveState(`Encrypted locally · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
      window.dispatchEvent(new CustomEvent('sharecapsule:finance-vault-saved', { detail: { updatedAt: vaultRecord.updatedAt } }));
    } catch (error) {
      console.error(error);
      setSaveState('Could not save locally');
      throw error;
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    dirty = true;
    setSaveState('Unsaved changes…');
    saveTimer = setTimeout(() => persist().catch(() => {}), 450);
  }

  function setSaveState(text) {
    const node = $('saveState');
    if (node) node.textContent = text;
  }

  function showGate(hasVault) {
    $('app').hidden = true;
    $('vaultGate').hidden = false;
    $('lockButton').hidden = true;
    $('newVaultPanel').hidden = hasVault;
    $('unlockVaultPanel').hidden = !hasVault;
    $('newPassphrase').value = '';
    $('confirmPassphrase').value = '';
    $('unlockPassphrase').value = '';
    $('createError').textContent = '';
    $('unlockError').textContent = '';
  }

  function showApp() {
    $('vaultGate').hidden = true;
    $('app').hidden = false;
    $('lockButton').hidden = false;
    $('transactionDate').value = nowIsoDate();
    vaultSession()?.touch();
    resetAutoLock();
    renderAll();
  }

  function lockVault() {
    clearTimeout(saveTimer);
    saveTimer = null;
    clearTimeout(lockTimer);
    currentKey = null;
    state = null;
    dirty = false;
    vaultSession()?.clear();
    showGate(true);
  }

  function resetAutoLock() {
    if (!currentKey) return;
    vaultSession()?.touch();
    clearTimeout(lockTimer);
    lockTimer = setTimeout(lockVault, AUTO_LOCK_MS);
  }

  function monthlyStats() {
    const month = currentMonthKey();
    let income = 0;
    let expenses = 0;
    const byCategory = {};
    for (const transaction of state.transactions) {
      if (!String(transaction.date || '').startsWith(month)) continue;
      const amount = Math.abs(num(transaction.amount));
      if (transaction.type === 'income') income += amount;
      else if (transaction.type === 'expense') {
        expenses += amount;
        const key = categoryKey(transaction.category || 'Other');
        byCategory[key] = (byCategory[key] || 0) + amount;
      }
    }
    return { income, expenses, net: income - expenses, byCategory };
  }

  function balanceStats() {
    const assets = state.accounts.reduce((sum, account) => sum + Math.max(0, num(account.balance)), 0);
    const cash = state.accounts.filter((account) => String(account.type).toLowerCase() === 'cash').reduce((sum, account) => sum + Math.max(0, num(account.balance)), 0);
    const debt = state.debts.reduce((sum, item) => sum + Math.max(0, num(item.balance)), 0);
    return { assets, cash, debt, netWorth: assets - debt };
  }

  function goalStats() {
    const target = state.goals.reduce((sum, goal) => sum + Math.max(0, num(goal.target)), 0);
    const current = state.goals.reduce((sum, goal) => sum + Math.max(0, Math.min(num(goal.current), num(goal.target))), 0);
    return { target, current, funded: target > 0 ? current / target : 0 };
  }

  function renderAll() {
    if (!state) return;
    renderMetrics();
    renderCashFlow();
    renderAttention();
    renderProjection();
    renderTransactions();
    renderBudgets();
    renderAccounts();
    renderDebts();
    renderGoals();
    renderPlanner();
  }

  function renderMetrics() {
    const monthly = monthlyStats();
    const balances = balanceStats();
    const goals = goalStats();
    const savingsRate = monthly.income > 0 ? monthly.net / monthly.income : 0;
    const runway = monthly.expenses > 0 ? balances.cash / monthly.expenses : 0;
    const metrics = [
      ['Monthly income', money.format(monthly.income), 'Current calendar month'],
      ['Monthly spending', money.format(monthly.expenses), 'Current calendar month'],
      ['Monthly cash flow', money.format(monthly.net), monthly.net >= 0 ? 'Surplus' : 'Deficit'],
      ['Net worth', money.format(balances.netWorth), `${money.format(balances.assets)} assets − ${money.format(balances.debt)} debt`],
      ['Savings rate', monthly.income > 0 ? pct.format(savingsRate) : '—', 'Income minus tracked expenses'],
      ['Cash runway', monthly.expenses > 0 ? `${runway.toFixed(1)} mo` : '—', 'Cash assets ÷ monthly expenses'],
      ['Total debt', money.format(balances.debt), `${state.debts.length} debt account${state.debts.length === 1 ? '' : 's'}`],
      ['Goals funded', goals.target > 0 ? pct.format(goals.funded) : '—', goals.target > 0 ? `${money.format(goals.current)} of ${money.format(goals.target)}` : 'No goals yet']
    ];
    $('metricGrid').innerHTML = metrics.map(([label, value, sub]) => `<article class="metric-card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></article>`).join('');
  }

  function renderCashFlow() {
    const stats = monthlyStats();
    $('monthLabel').textContent = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const max = Math.max(stats.income, stats.expenses, 1);
    const lines = [['Income', stats.income, 'income'], ['Expenses', stats.expenses, 'expense'], ['Surplus / deficit', Math.abs(stats.net), stats.net >= 0 ? 'income' : 'expense']];
    $('cashflowVisual').innerHTML = lines.map(([name, value, type]) => `<div class="cash-line"><span class="name">${esc(name)}</span><div class="bar-track"><div class="bar-fill ${type === 'expense' ? 'expense' : ''}" style="width:${clamp((value / max) * 100, 0, 100).toFixed(1)}%"></div></div><span class="amount">${esc(money.format(name === 'Surplus / deficit' ? stats.net : value))}</span></div>`).join('');
  }

  function buildAttention() {
    const monthly = monthlyStats();
    const balances = balanceStats();
    const items = [];
    const runway = monthly.expenses > 0 ? balances.cash / monthly.expenses : null;
    if (monthly.income === 0 && monthly.expenses === 0) items.push({ level: 'info', title: 'Add this month’s transactions', detail: 'Cash-flow guidance becomes useful once income and expenses are entered.' });
    if (monthly.net < 0) items.push({ level: 'bad', title: 'Monthly cash flow is negative', detail: `Tracked expenses exceed income by ${money.format(Math.abs(monthly.net))}. Review flexible spending and fixed obligations.` });
    if (runway !== null && runway < 3) items.push({ level: 'warn', title: 'Cash reserve is below 3 months', detail: `Tracked cash covers about ${runway.toFixed(1)} months of current expenses.` });
    const highApr = [...state.debts].filter((debt) => num(debt.apr) >= 10).sort((a, b) => num(b.apr) - num(a.apr))[0];
    if (highApr) items.push({ level: 'warn', title: 'High-interest debt is present', detail: `${highApr.name || 'Debt'} is entered at ${num(highApr.apr).toFixed(2)}% APR.` });
    const over = state.budgets.filter((budget) => (monthly.byCategory[categoryKey(budget.category)] || 0) > num(budget.amount));
    if (over.length) items.push({ level: 'warn', title: `${over.length} budget categor${over.length === 1 ? 'y is' : 'ies are'} over target`, detail: 'Open Budget to see where current-month spending is above plan.' });
    if (!items.length) items.push({ level: 'info', title: 'No immediate warning from tracked data', detail: 'Review the Planner for next-step guidance and keep balances current.' });
    return items.slice(0, 5);
  }

  function renderAttention() {
    $('attentionList').innerHTML = buildAttention().map((item) => `<div class="attention-item"><span class="attention-dot ${item.level}"></span><div><strong>${esc(item.title)}</strong><span>${esc(item.detail)}</span></div></div>`).join('');
  }

  function renderProjection() {
    const monthly = monthlyStats();
    const balances = balanceStats();
    const points = [];
    let projected = balances.cash;
    for (let i = 1; i <= 12; i++) {
      projected += monthly.net;
      const date = new Date();
      date.setMonth(date.getMonth() + i);
      points.push({ label: date.toLocaleDateString(undefined, { month: 'short' }), value: projected });
    }
    const absMax = Math.max(...points.map((point) => Math.abs(point.value)), 1);
    $('projection').innerHTML = points.map((point) => {
      const height = clamp((Math.abs(point.value) / absMax) * 100, 5, 100);
      return `<div class="projection-month"><div class="projection-bar-wrap"><div class="projection-bar" style="height:${height.toFixed(1)}%"></div></div><strong>${esc(point.label)}</strong><span>${esc(money.format(point.value))}</span></div>`;
    }).join('');
  }

  function renderTransactions() {
    const rows = [...state.transactions].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 200);
    $('transactionRows').innerHTML = rows.length ? rows.map((transaction) => `<tr><td>${esc(transaction.date)}</td><td>${esc(transaction.description)}</td><td>${esc(transaction.category)}</td><td class="number">${transaction.type === 'income' ? '+' : '−'}${esc(money2.format(Math.abs(num(transaction.amount))))}</td><td><button class="delete-row" data-delete-transaction="${esc(transaction.id)}" type="button">Remove</button></td></tr>`).join('') : '<tr><td colspan="5"><div class="empty-state">No transactions yet.</div></td></tr>';
    qsa('[data-delete-transaction]').forEach((button) => button.addEventListener('click', () => { state.transactions = state.transactions.filter((item) => item.id !== button.dataset.deleteTransaction); scheduleSave(); renderAll(); }));
  }

  function renderBudgets() {
    const monthly = monthlyStats();
    const items = [...state.budgets].sort((a, b) => String(a.category).localeCompare(String(b.category)));
    $('budgetList').innerHTML = items.length ? items.map((budget) => {
      const target = Math.max(0, num(budget.amount));
      const spent = monthly.byCategory[categoryKey(budget.category)] || 0;
      const ratio = target > 0 ? spent / target : (spent > 0 ? 2 : 0);
      return `<div class="stack-item"><div class="stack-item-top"><div><h4>${esc(budget.category)}</h4><div class="meta">${esc(money.format(spent))} spent of ${esc(money.format(target))}</div></div><div class="money">${esc(pct.format(ratio))}</div></div><div class="progress-track"><div class="progress-bar ${ratio > 1 ? 'over' : ''}" style="width:${clamp(ratio * 100, 0, 100).toFixed(1)}%"></div></div><div class="stack-actions"><button class="delete-row" data-delete-budget="${esc(budget.id)}" type="button">Remove</button></div></div>`;
    }).join('') : '<div class="empty-state">Add a few monthly spending targets to compare your plan with actual transactions.</div>';
    qsa('[data-delete-budget]').forEach((button) => button.addEventListener('click', () => { state.budgets = state.budgets.filter((item) => item.id !== button.dataset.deleteBudget); scheduleSave(); renderAll(); }));
  }

  function renderAccounts() {
    const items = [...state.accounts].sort((a, b) => num(b.balance) - num(a.balance));
    $('accountList').innerHTML = items.length ? items.map((account) => `<div class="stack-item"><div class="stack-item-top"><div><h4>${esc(account.name)}</h4><div class="meta">${esc(account.type)}</div></div><div class="money">${esc(money2.format(Math.max(0, num(account.balance))))}</div></div><div class="stack-actions"><button class="delete-row" data-delete-account="${esc(account.id)}" type="button">Remove</button></div></div>`).join('') : '<div class="empty-state">Add cash, investments, retirement balances, property and other assets.</div>';
    qsa('[data-delete-account]').forEach((button) => button.addEventListener('click', () => { state.accounts = state.accounts.filter((item) => item.id !== button.dataset.deleteAccount); scheduleSave(); renderAll(); }));
  }

  function renderDebts() {
    const items = [...state.debts].sort((a, b) => num(b.apr) - num(a.apr));
    $('debtList').innerHTML = items.length ? items.map((debt, index) => {
      const interest = Math.max(0, num(debt.balance)) * Math.max(0, num(debt.apr)) / 100 / 12;
      return `<div class="stack-item"><div class="stack-item-top"><div><h4>${index === 0 ? 'Payoff priority · ' : ''}${esc(debt.name)}</h4><div class="meta">${esc(num(debt.apr).toFixed(2))}% APR · ${esc(money2.format(num(debt.minimum)))} minimum · about ${esc(money2.format(interest))}/mo simple interest at current balance</div></div><div class="money">${esc(money2.format(Math.max(0, num(debt.balance))))}</div></div><div class="stack-actions"><button class="delete-row" data-delete-debt="${esc(debt.id)}" type="button">Remove</button></div></div>`;
    }).join('') : '<div class="empty-state">No debt entered. If you carry debt, add the balance, APR and minimum payment.</div>';
    qsa('[data-delete-debt]').forEach((button) => button.addEventListener('click', () => { state.debts = state.debts.filter((item) => item.id !== button.dataset.deleteDebt); scheduleSave(); renderAll(); }));
  }

  function renderGoals() {
    const items = [...state.goals];
    $('goalList').innerHTML = items.length ? items.map((goal) => {
      const target = Math.max(1, num(goal.target));
      const current = clamp(num(goal.current), 0, target);
      const remaining = Math.max(0, target - current);
      const monthly = Math.max(0, num(goal.monthly));
      const months = remaining === 0 ? 0 : monthly > 0 ? Math.ceil(remaining / monthly) : Infinity;
      const timeline = months === 0 ? 'Goal funded' : Number.isFinite(months) ? `About ${months} month${months === 1 ? '' : 's'} at current contribution` : 'Add a monthly contribution to estimate timing';
      return `<div class="stack-item"><div class="stack-item-top"><div><h4>${esc(goal.name)}</h4><div class="meta">${esc(timeline)}</div></div><div class="money">${esc(money.format(current))} / ${esc(money.format(target))}</div></div><div class="progress-track"><div class="progress-bar" style="width:${clamp((current / target) * 100, 0, 100).toFixed(1)}%"></div></div><div class="stack-actions"><button class="delete-row" data-delete-goal="${esc(goal.id)}" type="button">Remove</button></div></div>`;
    }).join('') : '<div class="empty-state">Add an emergency fund, home, education, travel or other savings goal.</div>';
    qsa('[data-delete-goal]').forEach((button) => button.addEventListener('click', () => { state.goals = state.goals.filter((item) => item.id !== button.dataset.deleteGoal); scheduleSave(); renderAll(); }));
  }

  function buildPlan() {
    const monthly = monthlyStats();
    const balances = balanceStats();
    const cards = [];
    const savingsRate = monthly.income > 0 ? monthly.net / monthly.income : null;
    const runway = monthly.expenses > 0 ? balances.cash / monthly.expenses : null;
    const targetMonths = state.settings.emergencyFundTargetMonths || 6;

    if (monthly.net < 0) cards.push({ priority: 'Priority 1', title: 'Stop the monthly deficit', body: `Your tracked month is running ${money.format(Math.abs(monthly.net))} negative. A sustainable plan starts by bringing recurring outflow below recurring income.`, action: 'Review fixed bills first, then the largest flexible categories.' });
    else if (monthly.income > 0) cards.push({ priority: 'Foundation', title: 'Protect your positive cash flow', body: `Your tracked monthly surplus is ${money.format(monthly.net)}. Treat that surplus as a resource to assign intentionally rather than letting it disappear.`, action: 'Direct surplus toward reserves, high-cost debt and named goals.' });
    else cards.push({ priority: 'Start here', title: 'Complete one month of cash flow', body: 'The planner needs recurring income and spending to estimate savings rate, reserve coverage and a useful forward view.', action: 'Add recent income and expenses in Cash flow.' });

    if (runway !== null) {
      const reserveTarget = monthly.expenses * targetMonths;
      const gap = Math.max(0, reserveTarget - balances.cash);
      cards.push({ priority: 'Resilience', title: runway >= targetMonths ? 'Emergency reserve is on target' : 'Build your emergency reserve', body: `Cash assets currently cover about ${runway.toFixed(1)} months of tracked expenses. The workspace target is ${targetMonths} months (${money.format(reserveTarget)}).`, action: gap > 0 ? `Reserve gap: ${money.format(gap)}. Adjust the target to your job stability and household needs.` : 'Keep the reserve liquid and revisit after major life changes.' });
    }

    if (state.debts.length) {
      const sorted = [...state.debts].sort((a, b) => num(b.apr) - num(a.apr));
      const top = sorted[0];
      const minimums = sorted.reduce((sum, item) => sum + num(item.minimum), 0);
      cards.push({ priority: 'Debt', title: `Highest APR: ${top.name || 'Debt'}`, body: `${num(top.apr).toFixed(2)}% APR on ${money.format(num(top.balance))}. The avalanche method directs extra payoff dollars to the highest APR while maintaining required minimums elsewhere.`, action: `Tracked minimum payments total ${money.format(minimums)} per month. Confirm lender terms before changing payments.` });
    }

    if (savingsRate !== null) cards.push({ priority: 'Capacity', title: 'Know your savings rate', body: `Based on this month’s tracked income and expenses, your current cash-flow savings rate is ${pct.format(savingsRate)}. This is a planning signal, not a score.`, action: savingsRate < .1 ? 'Look for one recurring expense or income lever that can improve the monthly margin.' : 'Decide how much of the margin belongs to reserves, goals, investing and debt.' });

    const monthlyBudget = state.budgets.reduce((sum, item) => sum + Math.max(0, num(item.amount)), 0);
    if (monthlyBudget > 0 && monthly.income > 0) cards.push({ priority: 'Budget', title: 'Check planned spending against income', body: `Your category targets total ${money.format(monthlyBudget)} versus ${money.format(monthly.income)} of tracked monthly income.`, action: monthlyBudget > monthly.income ? 'Targets exceed tracked income; review categories before relying on the budget.' : `Unallocated amount before non-budgeted items: ${money.format(monthly.income - monthlyBudget)}.` });

    if (state.goals.length) {
      const monthlyGoalContrib = state.goals.reduce((sum, item) => sum + Math.max(0, num(item.monthly)), 0);
      cards.push({ priority: 'Goals', title: 'Fund priorities without double-counting cash', body: `Planned goal contributions total ${money.format(monthlyGoalContrib)} per month. Make sure those contributions fit inside your actual monthly surplus.`, action: monthly.net >= monthlyGoalContrib ? 'Current tracked surplus can cover the entered goal contributions.' : 'Entered goal contributions are above the current tracked monthly surplus.' });
    }
    return cards.slice(0, 8);
  }

  function renderPlanner() {
    $('plannerCards').innerHTML = buildPlan().map((card) => `<article class="planner-card"><div class="priority">${esc(card.priority)}</div><h3>${esc(card.title)}</h3><p>${esc(card.body)}</p><div class="action">${esc(card.action)}</div></article>`).join('');
  }

  function validateBackupRecord(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.format !== 'sharecapsule-private-finance-v1') return false;
    if (typeof record.salt !== 'string' || typeof record.iv !== 'string' || typeof record.ciphertext !== 'string') return false;
    if (record.kdf?.name !== 'PBKDF2' || record.kdf?.hash !== 'SHA-256') return false;
    if (record.cipher?.name !== 'AES-GCM') return false;
    try {
      const salt = base64ToBytes(record.salt);
      const iv = base64ToBytes(record.iv);
      const ciphertext = base64ToBytes(record.ciphertext);
      return salt.length >= 16 && iv.length === 12 && ciphertext.length > 16;
    } catch { return false; }
  }

  async function applyRemoteVaultRecord(record) {
    if (!validateBackupRecord(record)) throw new Error('Remote encrypted vault is invalid');
    clearTimeout(saveTimer);
    saveTimer = null;
    dirty = false;

    if (currentKey && state) {
      try {
        const nextState = await decryptRecordWithCurrentKey(record);
        vaultRecord = record;
        state = nextState;
        renderAll();
        resetAutoLock();
        setSaveState(`Synced from trusted device · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
        return { applied: true, unlocked: true };
      } catch (error) {
        console.error('Could not decrypt incoming vault with the current in-memory key', error);
        vaultRecord = record;
        currentKey = null;
        state = null;
        showGate(true);
        return { applied: true, unlocked: false, requiresUnlock: true };
      }
    }

    vaultRecord = record;
    return { applied: true, unlocked: false };
  }

  function openIncomeDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(INCOME_DB_NAME, INCOME_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(INCOME_STORE)) request.result.createObjectStore(INCOME_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function externalDbGet(database, storeName, id) {
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function externalDbPut(database, storeName, value) {
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readwrite').objectStore(storeName).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function loadIncomeLabStateForExport() {
    if (typeof indexedDB.databases === 'function') {
      try {
        const databases = await indexedDB.databases();
        if (!databases.some((item) => item.name === INCOME_DB_NAME)) return null;
      } catch (_) { /* Fall back to opening the known local database. */ }
    }
    const incomeDb = await openIncomeDb();
    try {
      const keyRecord = await externalDbGet(incomeDb, INCOME_STORE, INCOME_KEY_ID);
      const record = await externalDbGet(incomeDb, INCOME_STORE, INCOME_STATE_ID);
      if (!keyRecord?.key || !record?.iv || !record?.ciphertext) return null;
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv) }, keyRecord.key, base64ToBytes(record.ciphertext));
      const parsed = JSON.parse(decoder.decode(plaintext));
      if (!parsed || !Array.isArray(parsed.projects)) return null;
      return { version: 1, focusProjectId: parsed.focusProjectId || null, projects: parsed.projects.slice(0, 100) };
    } finally {
      incomeDb.close();
    }
  }

  async function encryptPortablePayload(value, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
    return {
      format: 'sharecapsule-income-projects-portable-v1',
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext)
    };
  }

  function validatePortablePayload(payload) {
    if (!payload || payload.format !== 'sharecapsule-income-projects-portable-v1') return false;
    if (typeof payload.iv !== 'string' || typeof payload.ciphertext !== 'string') return false;
    try {
      return base64ToBytes(payload.iv).length === 12 && base64ToBytes(payload.ciphertext).length > 16;
    } catch (_) { return false; }
  }

  async function restoreIncomeLabFromPortable(payload, key) {
    if (!validatePortablePayload(payload)) throw new Error('Income Lab migration payload is invalid');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(payload.iv) }, key, base64ToBytes(payload.ciphertext));
    const parsed = JSON.parse(decoder.decode(plaintext));
    if (!parsed || !Array.isArray(parsed.projects)) throw new Error('Income Lab migration data is invalid');
    const nextState = { version: 1, focusProjectId: parsed.focusProjectId || null, projects: parsed.projects.slice(0, 100) };

    const incomeDb = await openIncomeDb();
    try {
      let keyRecord = await externalDbGet(incomeDb, INCOME_STORE, INCOME_KEY_ID);
      if (!keyRecord?.key) {
        const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        keyRecord = { id: INCOME_KEY_ID, key: deviceKey, createdAt: new Date().toISOString() };
        await externalDbPut(incomeDb, INCOME_STORE, keyRecord);
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyRecord.key, encoder.encode(JSON.stringify(nextState)));
      await externalDbPut(incomeDb, INCOME_STORE, {
        id: INCOME_STATE_ID,
        format: 'sharecapsule-income-projects-v1',
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext),
        updatedAt: new Date().toISOString()
      });
    } finally {
      incomeDb.close();
    }
  }

  async function restorePendingMigrationData() {
    const pending = await dbGet(MIGRATION_PENDING_ID);
    if (!pending) return false;
    if (pending.incomeLab) await restoreIncomeLabFromPortable(pending.incomeLab, currentKey);
    await dbDelete(MIGRATION_PENDING_ID);
    return Boolean(pending.incomeLab);
  }

  async function importBackup(file) {
    if (!file || file.size > 25 * 1024 * 1024) throw new Error('Export file is too large');
    const text = await file.text();
    const parsed = JSON.parse(text);
    let record;
    let portable = null;

    if (parsed?.format === PORTABLE_EXPORT_FORMAT) {
      if (parsed.version !== 2 || !validateBackupRecord(parsed.vault)) throw new Error('This ShareCapsule records export is invalid');
      if (parsed.incomeLab && !validatePortablePayload(parsed.incomeLab)) throw new Error('The Income Lab section of this export is invalid');
      portable = parsed;
      record = { ...parsed.vault, id: VAULT_ID };
    } else {
      if (!validateBackupRecord(parsed)) throw new Error('This is not a valid ShareCapsule encrypted finance backup or records export');
      record = { ...parsed, id: VAULT_ID };
    }

    await dbPut(record);
    if (portable?.incomeLab) {
      await dbPut({
        id: MIGRATION_PENDING_ID,
        format: 'sharecapsule-domain-migration-pending-v1',
        incomeLab: portable.incomeLab,
        sourceOrigin: typeof portable.sourceOrigin === 'string' ? portable.sourceOrigin : '',
        importedAt: new Date().toISOString()
      });
    } else {
      await dbDelete(MIGRATION_PENDING_ID);
    }

    vaultRecord = record;
    dirty = false;
    lockVault();
    alert(portable
      ? 'Records imported. Unlock with your existing vault passphrase. Income Lab progress will be restored locally after a successful unlock.'
      : 'Encrypted backup restored. Unlock it with the passphrase used when the backup was created.');
  }

  async function exportBackup() {
    if (!currentKey || !state) throw new Error('Unlock the vault before exporting records');
    if (dirty) await persist();
    const record = await dbGet(VAULT_ID);
    if (!record) throw new Error('No encrypted finance vault was found');

    let incomeLab = null;
    try {
      const incomeState = await loadIncomeLabStateForExport();
      if (incomeState) incomeLab = await encryptPortablePayload(incomeState, currentKey);
    } catch (error) {
      console.error('Could not include Income Lab progress in export', error);
      throw new Error('Could not prepare the complete records export. Income Lab progress could not be read safely.');
    }

    const bundle = {
      format: PORTABLE_EXPORT_FORMAT,
      version: 2,
      exportedAt: new Date().toISOString(),
      sourceOrigin: window.location.origin,
      vault: record,
      incomeLab
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sharecapsule-finance-records-${nowIsoDate()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaveState(`Portable encrypted export downloaded · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  }

  function parseCsvLine(line) {
    const cells = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
      } else if (char === ',' && !quoted) { cells.push(value.trim()); value = ''; }
      else value += char;
    }
    cells.push(value.trim());
    return cells;
  }

  async function importCsv(file) {
    if (!file || file.size > 10 * 1024 * 1024) throw new Error('CSV file is too large');
    const text = await file.text();
    const lines = text.replace(/\r/g, '').split('\n').filter((line) => line.trim());
    if (lines.length < 2) throw new Error('CSV has no transaction rows');
    const headers = parseCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
    const index = (name) => headers.indexOf(name);
    const required = ['date', 'description', 'amount', 'category'];
    if (required.some((name) => index(name) < 0)) throw new Error('CSV needs date, description, amount and category columns. A type column is optional.');
    const imported = [];
    for (const line of lines.slice(1, 5001)) {
      const cells = parseCsvLine(line);
      const rawAmount = Number(String(cells[index('amount')] || '').replace(/[$,()]/g, (match) => match === '(' ? '-' : match === ')' ? '' : ''));
      if (!Number.isFinite(rawAmount) || rawAmount === 0) continue;
      const rawType = index('type') >= 0 ? String(cells[index('type')] || '').toLowerCase() : '';
      const type = rawType === 'income' || rawType === 'expense' ? rawType : rawAmount < 0 ? 'expense' : 'income';
      const date = String(cells[index('date')] || '').slice(0, 10);
      const description = String(cells[index('description')] || '').slice(0, 80);
      const category = String(cells[index('category')] || 'Other').slice(0, 40);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description) continue;
      imported.push({ id: uid(), date, description, category, amount: Math.abs(rawAmount), type });
    }
    if (!imported.length) throw new Error('No valid rows were found. Dates must use YYYY-MM-DD.');
    state.transactions.push(...imported);
    scheduleSave();
    renderAll();
    alert(`${imported.length} transaction${imported.length === 1 ? '' : 's'} imported locally. Review income/expense classification because bank CSV formats vary.`);
  }

  function bindForms() {
    $('createVaultForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const passphrase = $('newPassphrase').value;
      const confirmation = $('confirmPassphrase').value;
      $('createError').textContent = '';
      if (passphrase.length < 12) { $('createError').textContent = 'Use at least 12 characters.'; return; }
      if (passphrase !== confirmation) { $('createError').textContent = 'Passphrases do not match.'; return; }
      const submit = event.submitter;
      submit.disabled = true;
      submit.textContent = 'Creating vault…';
      try {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const material = await deriveKeyMaterial(passphrase, salt);
        currentKey = material.key;
        state = defaultState();
        vaultRecord = await encryptState(state, currentKey, salt);
        await dbPut(vaultRecord);
        dirty = false;
        try { await vaultSession()?.start(material.rawKey); } catch (sessionError) { console.warn('Vault session resume unavailable', sessionError); } finally { material.rawKey.fill(0); }
        showApp();
      } catch (error) {
        console.error(error);
        currentKey = null;
        state = null;
        $('createError').textContent = 'Could not create the encrypted vault in this browser.';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Create encrypted vault';
      }
    });

    $('unlockVaultForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = event.submitter;
      submit.disabled = true;
      submit.textContent = 'Decrypting…';
      $('unlockError').textContent = '';
      try {
        const result = await decryptRecord(vaultRecord, $('unlockPassphrase').value);
        currentKey = result.key;
        state = result.state;
        dirty = false;
        try { await vaultSession()?.start(result.rawKey); } catch (sessionError) { console.warn('Vault session resume unavailable', sessionError); } finally { result.rawKey.fill(0); }
        let migrationMessage = '';
        try {
          if (await restorePendingMigrationData()) migrationMessage = 'Income Lab progress from the imported records file was restored on this domain.';
        } catch (migrationError) {
          console.error('Could not restore migrated Income Lab progress', migrationError);
          migrationMessage = 'Vault unlocked, but Income Lab progress could not be restored. Keep the exported records file and try the import again.';
        }
        showApp();
        if (migrationMessage) setTimeout(() => alert(migrationMessage), 0);
      } catch (error) {
        console.error(error);
        currentKey = null;
        state = null;
        $('unlockError').textContent = 'Unable to unlock. Check the passphrase or restore a known-good encrypted backup.';
      } finally {
        $('unlockPassphrase').value = '';
        submit.disabled = false;
        submit.textContent = 'Unlock vault';
      }
    });

    $('transactionForm').addEventListener('submit', (event) => {
      event.preventDefault();
      state.transactions.push({ id: uid(), date: $('transactionDate').value, type: $('transactionType').value, description: $('transactionDescription').value.trim().slice(0, 80), amount: Math.abs(num($('transactionAmount').value)), category: $('transactionCategory').value.trim().slice(0, 40) });
      event.currentTarget.reset();
      $('transactionDate').value = nowIsoDate();
      scheduleSave(); renderAll();
    });

    $('budgetForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const category = $('budgetCategory').value.trim().slice(0, 40);
      const existing = state.budgets.find((item) => categoryKey(item.category) === categoryKey(category));
      if (existing) existing.amount = Math.max(0, num($('budgetAmount').value));
      else state.budgets.push({ id: uid(), category, amount: Math.max(0, num($('budgetAmount').value)) });
      event.currentTarget.reset(); scheduleSave(); renderAll();
    });

    $('accountForm').addEventListener('submit', (event) => {
      event.preventDefault();
      state.accounts.push({ id: uid(), name: $('accountName').value.trim().slice(0, 50), type: $('accountType').value, balance: Math.max(0, num($('accountBalance').value)) });
      event.currentTarget.reset(); scheduleSave(); renderAll();
    });

    $('debtForm').addEventListener('submit', (event) => {
      event.preventDefault();
      state.debts.push({ id: uid(), name: $('debtName').value.trim().slice(0, 50), balance: Math.max(0, num($('debtBalance').value)), apr: clamp(num($('debtApr').value), 0, 100), minimum: Math.max(0, num($('debtMinimum').value)) });
      event.currentTarget.reset(); scheduleSave(); renderAll();
    });

    $('goalForm').addEventListener('submit', (event) => {
      event.preventDefault();
      state.goals.push({ id: uid(), name: $('goalName').value.trim().slice(0, 60), target: Math.max(1, num($('goalTarget').value)), current: Math.max(0, num($('goalCurrent').value)), monthly: Math.max(0, num($('goalMonthly').value)) });
      event.currentTarget.reset(); scheduleSave(); renderAll();
    });
  }

  function bindButtons() {
    qsa('.nav-tab').forEach((button) => button.addEventListener('click', () => {
      qsa('.nav-tab').forEach((node) => node.classList.toggle('active', node === button));
      qsa('[data-view-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === button.dataset.view));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));

    $('lockButton').addEventListener('click', async () => { if (dirty) await persist(); lockVault(); });
    $('refreshPlan').addEventListener('click', renderPlanner);
    $('importCsvButton').addEventListener('click', () => $('csvFileInput').click());
    $('exportBackupButton').addEventListener('click', async () => {
      try { await exportBackup(); } catch (error) { console.error(error); alert(error.message || 'Could not export records.'); }
    });
    $('importBackupButton').addEventListener('click', () => $('backupFileInput').click());
    $('importBackupAtGate').addEventListener('click', () => $('backupFileInput').click());
    $('importBackupUnlock').addEventListener('click', () => $('backupFileInput').click());

    $('csvFileInput').addEventListener('change', async (event) => {
      try { await importCsv(event.target.files?.[0]); } catch (error) { alert(error.message || 'Could not import CSV.'); }
      event.target.value = '';
    });

    $('backupFileInput').addEventListener('change', async (event) => {
      try {
        const file = event.target.files?.[0];
        if (file && confirm('Import this ShareCapsule records file? It will replace the encrypted finance vault currently stored in this browser.')) await importBackup(file);
      } catch (error) { alert(error.message || 'Could not restore backup.'); }
      event.target.value = '';
    });

    $('clearTransactions').addEventListener('click', () => {
      if (!state.transactions.length) return;
      if (confirm('Remove all transactions from this encrypted vault?')) { state.transactions = []; scheduleSave(); renderAll(); }
    });

    const erase = async () => {
      if (!confirm('Permanently erase the local encrypted finance vault from this browser? This cannot be undone without an encrypted backup.')) return;
      await dbDelete(VAULT_ID);
      await dbDelete(MIGRATION_PENDING_ID);
      vaultRecord = null; currentKey = null; state = null; dirty = false;
      vaultSession()?.clear();
      clearTimeout(lockTimer); clearTimeout(saveTimer); saveTimer = null;
      showGate(false);
    };
    $('eraseVaultButton').addEventListener('click', erase);
    $('resetVaultButton').addEventListener('click', erase);
  }

  function bindAutoLock() {
    ['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => document.addEventListener(eventName, resetAutoLock, { passive: true }));
    window.addEventListener('beforeunload', () => { currentKey = null; state = null; });
  }

  window.ShareCapsuleFinanceSyncBridge = Object.freeze({
    async flushPendingSave() {
      if (dirty && state && currentKey && vaultRecord) await persist();
      return vaultRecord ? { updatedAt: vaultRecord.updatedAt } : null;
    },
    async applyRemoteRecord(record) {
      return applyRemoteVaultRecord(record);
    },
    isUnlocked() {
      return Boolean(currentKey && state);
    }
  });

  async function init() {
    if (!window.crypto?.subtle || !window.indexedDB) {
      document.body.innerHTML = '<div class="noscript">This browser does not provide the encryption and local database capabilities required by Private Finance Planner.</div>';
      return;
    }
    try {
      db = await openDb();
      vaultRecord = await dbGet(VAULT_ID);
      bindForms(); bindButtons(); bindAutoLock();
      if (vaultRecord && vaultSession()?.isActive()) {
        try {
          currentKey = await vaultSession().restoreKey();
          if (currentKey) {
            state = await decryptRecordWithCurrentKey(vaultRecord);
            dirty = false;
            showApp();
            return;
          }
        } catch (sessionError) {
          console.warn('Could not resume vault session', sessionError);
          currentKey = null;
          state = null;
          vaultSession()?.clear();
        }
      }
      showGate(Boolean(vaultRecord));
    } catch (error) {
      console.error(error);
      document.body.innerHTML = '<div class="noscript">Private Finance Planner could not open secure local storage in this browser. Private browsing policies or browser settings may be blocking IndexedDB.</div>';
    }
  }

  init();
})();

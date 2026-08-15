(() => {
  'use strict';

  const DB_NAME = 'sharecapsule-private-finance';
  const DB_VERSION = 1;
  const STORE_NAME = 'vaults';
  const VAULT_ID = 'primary';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const $ = (id) => document.getElementById(id);
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const pct1 = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

  const STATES = [
    ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']
  ];

  const REGION_BY_STATE = {
    CT:'northeast',ME:'northeast',MA:'northeast',NH:'northeast',RI:'northeast',VT:'northeast',NJ:'northeast',NY:'northeast',PA:'northeast',
    IN:'midwest',IL:'midwest',MI:'midwest',OH:'midwest',WI:'midwest',IA:'midwest',KS:'midwest',MN:'midwest',MO:'midwest',NE:'midwest',ND:'midwest',SD:'midwest',
    DE:'south',FL:'south',GA:'south',MD:'south',NC:'south',SC:'south',VA:'south',DC:'south',WV:'south',AL:'south',KY:'south',MS:'south',TN:'south',AR:'south',LA:'south',OK:'south',TX:'south',
    AZ:'west',CO:'west',ID:'west',MT:'west',NV:'west',NM:'west',UT:'west',WY:'west',AK:'west',CA:'west',HI:'west',OR:'west',WA:'west'
  };

  const GROUPS = [
    { id:'housing', label:'Housing + utilities', peer: c => c.housing, user:['housing','utilities'], kind:'structural', note:'BLS Housing is broader than the planner categories and includes shelter, utilities, household operations and related housing costs.' },
    { id:'food', label:'Food', peer: c => c.food, user:['groceries','dining'], kind:'flexible', note:'Your Groceries + Dining are compared with the broader BLS Food category.' },
    { id:'transportation', label:'Transportation', peer: c => c.transportation, user:['transportation'], kind:'structural', note:'Vehicle, fuel and transportation choices often change more slowly than day-to-day discretionary spending.' },
    { id:'healthcare', label:'Healthcare', peer: c => c.healthcare, user:['healthcare'], kind:'context', note:'Higher healthcare spending can be appropriate; this comparison is context, not a cut target.' },
    { id:'education', label:'Education', peer: c => c.education, user:['education'], kind:'context', note:'Education varies greatly by household stage and should not be reduced simply to match a peer mean.' },
    { id:'lifestyle', label:'Lifestyle & personal', peer: c => sum(c.apparel,c.entertainment,c.personalCare,c.miscellaneous), user:['entertainment','shopping'], kind:'flexible', note:'This is an approximate alignment of Entertainment + Shopping with BLS apparel, entertainment, personal care and miscellaneous spending.' }
  ];

  let benchmarks = null;

  function sum(...values) { return values.reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0); }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function key(value) { return String(value || '').trim().toLowerCase(); }
  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => reject(new Error('No finance vault exists on this browser yet. Open the planner and create or pair a vault first.'));
    });
  }

  function dbGet(db, id) {
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(STORE_NAME)) { resolve(null); return; }
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function decryptVault(record, passphrase) {
    const iterations = Number(record?.kdf?.iterations || 600000);
    if (!record || !record.salt || !record.iv || !record.ciphertext || !Number.isInteger(iterations)) throw new Error('The local finance vault is not in a supported format.');
    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const cryptoKey = await crypto.subtle.deriveKey(
      { name:'PBKDF2', salt:fromBase64(record.salt), iterations, hash:'SHA-256' },
      baseKey,
      { name:'AES-GCM', length:256 },
      false,
      ['decrypt']
    );
    const plaintext = await crypto.subtle.decrypt({ name:'AES-GCM', iv:fromBase64(record.iv) }, cryptoKey, fromBase64(record.ciphertext));
    return JSON.parse(decoder.decode(plaintext));
  }

  function selectCohort(regionKey, income) {
    const region = benchmarks?.regions?.[regionKey];
    if (!region) throw new Error('No peer benchmark is available for this region.');
    const cohort = region.cohorts.find((item) => income >= Number(item.min || 0) && (item.max == null || income <= Number(item.max)));
    if (!cohort) throw new Error('No peer income cohort matches the amount entered.');
    return { region, cohort };
  }

  function recentStats(vault) {
    const transactions = Array.isArray(vault.transactions) ? vault.transactions : [];
    const cutoff = new Date();
    cutoff.setHours(0,0,0,0);
    cutoff.setDate(cutoff.getDate() - 89);
    const recent = transactions.filter((transaction) => {
      const date = new Date(`${String(transaction.date || '').slice(0,10)}T00:00:00`);
      return !Number.isNaN(date.getTime()) && date >= cutoff;
    });
    const months = new Set(recent.map(item => String(item.date || '').slice(0,7)).filter(value => /^\d{4}-\d{2}$/.test(value)));
    const divisor = Math.max(1, months.size);
    let income = 0;
    let expenses = 0;
    const categories = {};
    for (const transaction of recent) {
      const amount = Math.abs(Number(transaction.amount) || 0);
      if (transaction.type === 'income') income += amount;
      if (transaction.type === 'expense') {
        expenses += amount;
        categories[key(transaction.category)] = (categories[key(transaction.category)] || 0) + amount;
      }
    }
    Object.keys(categories).forEach(category => { categories[category] /= divisor; });
    return {
      monthlyIncome: income / divisor,
      monthlyExpenses: expenses / divisor,
      categories,
      monthsObserved: divisor,
      transactionCount: recent.length
    };
  }

  function localBalanceStats(vault) {
    const accounts = Array.isArray(vault.accounts) ? vault.accounts : [];
    const debts = Array.isArray(vault.debts) ? vault.debts : [];
    const cash = accounts.filter(item => key(item.type) === 'cash').reduce((total,item) => total + Math.max(0,Number(item.balance)||0),0);
    const highestAprDebt = debts.filter(item => (Number(item.balance)||0) > 0).sort((a,b) => (Number(b.apr)||0) - (Number(a.apr)||0))[0] || null;
    return { cash, debts, highestAprDebt };
  }

  function userGroupAmount(group, stats) {
    return group.user.reduce((total, category) => total + (stats.categories[category] || 0), 0);
  }

  function compareGroups(stats, cohort) {
    const peerTotal = Number(cohort.annualExpenditures) || 0;
    const userTotal = stats.monthlyExpenses || 0;
    return GROUPS.map(group => {
      const userMonthly = userGroupAmount(group, stats);
      const peerAnnual = Number(group.peer(cohort)) || 0;
      const peerMonthly = peerAnnual / 12;
      const userShare = userTotal > 0 ? userMonthly / userTotal : 0;
      const peerShare = peerTotal > 0 ? peerAnnual / peerTotal : 0;
      const relative = peerShare > 0 ? userShare / peerShare : null;
      const pointDelta = userShare - peerShare;
      let status = 'context';
      let statusLabel = 'Context';
      if (relative != null && group.kind !== 'context') {
        if (relative > 1.15 && pointDelta > .02) { status = 'review'; statusLabel = 'Review'; }
        else if (relative >= .85 && relative <= 1.15) { status = 'near'; statusLabel = 'Near peer'; }
      }
      return { ...group, userMonthly, peerMonthly, userShare, peerShare, relative, pointDelta, status, statusLabel };
    });
  }

  function scoreHealth(stats, balances, comparisons) {
    const cashFlowRate = stats.monthlyIncome > 0 ? (stats.monthlyIncome - stats.monthlyExpenses) / stats.monthlyIncome : null;
    const runway = stats.monthlyExpenses > 0 ? balances.cash / stats.monthlyExpenses : null;
    const highestApr = Number(balances.highestAprDebt?.apr) || 0;

    let cashFlow = 0;
    if (cashFlowRate != null) cashFlow = cashFlowRate >= .10 ? 25 : cashFlowRate >= 0 ? 12.5 + (cashFlowRate / .10) * 12.5 : 0;
    const reserve = runway == null ? 0 : clamp(runway / 6, 0, 1) * 25;
    let debt = 20;
    if (highestApr >= 20) debt = 3;
    else if (highestApr >= 15) debt = 7;
    else if (highestApr >= 10) debt = 11;
    else if (highestApr > 0) debt = 17;

    const comparable = comparisons.filter(item => item.kind !== 'context' && item.peerShare > 0);
    const excess = comparable.reduce((total,item) => total + Math.max(0, item.userShare - item.peerShare * 1.15), 0);
    const alignment = clamp(15 - excess * 90, 0, 15);
    let capacity = 0;
    if (cashFlowRate != null) capacity = clamp(cashFlowRate / .15, 0, 1) * 15;

    const total = Math.round(cashFlow + reserve + debt + alignment + capacity);
    const label = total >= 80 ? 'Strong foundation' : total >= 65 ? 'Generally healthy' : total >= 50 ? 'Needs attention' : 'Priority improvements needed';
    return {
      total,
      label,
      runway,
      cashFlowRate,
      components: [
        { label:'Cash flow', score:cashFlow, max:25, detail:cashFlowRate == null ? 'Add income transactions for a stronger signal.' : `${pct1.format(cashFlowRate)} tracked margin` },
        { label:'Liquid reserve', score:reserve, max:25, detail:runway == null ? 'No spending baseline available.' : `${runway.toFixed(1)} months of tracked spending` },
        { label:'Debt cost', score:debt, max:20, detail:highestApr ? `${highestApr.toFixed(2)}% highest tracked APR` : 'No positive debt balance entered' },
        { label:'Peer spending alignment', score:alignment, max:15, detail:'Flags material over-allocation only; lower is not automatically better.' },
        { label:'Future capacity', score:capacity, max:15, detail:cashFlowRate == null ? 'Income data needed' : 'Based on recurring tracked margin' }
      ]
    };
  }

  function buildActions(stats, balances, comparisons, score) {
    const actions = [];
    const monthlyNet = stats.monthlyIncome - stats.monthlyExpenses;
    if (stats.monthlyIncome > 0 && monthlyNet < 0) actions.push({ priority:100, title:'Stop the recurring deficit first', detail:`Your recent tracked spending is about ${money.format(Math.abs(monthlyNet))} per month above tracked income. Review structural costs and the largest flexible categories before optimizing investments.` });
    if (score.runway != null && score.runway < 3) {
      const gap = Math.max(0, stats.monthlyExpenses * 3 - balances.cash);
      actions.push({ priority:90, title:'Build a 3-month liquidity checkpoint', detail:`Cash currently covers about ${score.runway.toFixed(1)} months of tracked spending. Reaching 3 months would require roughly ${money.format(gap)} more liquid reserve at the current spending level.` });
    }
    const topDebt = balances.highestAprDebt;
    if (topDebt && Number(topDebt.apr) >= 10) actions.push({ priority:95, title:`Prioritize ${topDebt.name || 'high-interest debt'}`, detail:`The highest tracked APR is ${Number(topDebt.apr).toFixed(2)}% on about ${money.format(Number(topDebt.balance)||0)}. After required payments and basic liquidity, high-cost debt deserves priority over discretionary expansion.` });

    comparisons.filter(item => item.status === 'review').forEach(item => {
      const peerAlignedAtUserScale = item.peerShare * stats.monthlyExpenses;
      const difference = Math.max(0, item.userMonthly - peerAlignedAtUserScale);
      if (item.kind === 'flexible') actions.push({ priority:70 + difference / 1000, title:`Review ${item.label.toLowerCase()}`, detail:`This category is ${pct1.format(item.userShare)} of your tracked spending versus ${pct1.format(item.peerShare)} for the peer cohort. Moving partway toward the peer share could free about ${money.format(difference)} per month; confirm the underlying transactions before changing the budget.` });
      else if (item.kind === 'structural') actions.push({ priority:60 + difference / 1000, title:`Review structural ${item.label.toLowerCase()} costs`, detail:`Your share is ${pct1.format(item.userShare)} versus ${pct1.format(item.peerShare)} for peers. Look for renewal, housing, vehicle, utility, insurance-linked or financing decisions rather than forcing an immediate short-term cut.` });
    });

    if (!actions.length && score.cashFlowRate != null && score.cashFlowRate >= .10) actions.push({ priority:40, title:'Protect the monthly margin', detail:`Your recent tracked margin is ${pct1.format(score.cashFlowRate)}. Assign it intentionally across emergency reserves, debt payoff, named goals and long-term investing instead of allowing lifestyle drift.` });
    if (!actions.length) actions.push({ priority:10, title:'Improve the data baseline', detail:'Keep at least two to three months of transactions, current cash balances and debt APRs in the private vault. A stronger baseline produces more useful comparisons.' });
    return actions.sort((a,b) => b.priority - a.priority).slice(0,3);
  }

  function renderComparisons(comparisons) {
    const maxShare = Math.max(.01, ...comparisons.flatMap(item => [item.userShare,item.peerShare]));
    $('comparisonList').innerHTML = comparisons.map(item => {
      const userWidth = clamp(item.userShare / maxShare * 100,0,100);
      const peerWidth = clamp(item.peerShare / maxShare * 100,0,100);
      return `<div class="comparison-row"><div class="comparison-head"><h3>${escapeHtml(item.label)}</h3><div class="comparison-number"><span>You</span><strong>${pct1.format(item.userShare)} · ${money.format(item.userMonthly)}/mo</strong></div><div class="comparison-number"><span>Peer</span><strong>${pct1.format(item.peerShare)} · ${money.format(item.peerMonthly)}/mo</strong></div><span class="signal ${item.status}">${item.statusLabel}</span></div><div class="dual-bar"><div class="bar user" title="Your share"><span style="width:${userWidth.toFixed(1)}%"></span></div><div class="bar" title="Peer share"><span style="width:${peerWidth.toFixed(1)}%"></span></div></div><div class="comparison-note">${escapeHtml(item.note)}</div></div>`;
    }).join('');
  }

  function renderActions(actions) {
    $('actionList').innerHTML = actions.map((action,index) => `<div class="action-card"><div class="action-rank">${index+1}</div><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.detail)}</p></div></div>`).join('');
  }

  function renderComponents(components) {
    $('scoreComponents').innerHTML = components.map(item => `<div class="component"><div class="component-top"><div><strong>${escapeHtml(item.label)}</strong><br><small>${escapeHtml(item.detail)}</small></div><strong>${Math.round(item.score)} / ${item.max}</strong></div><div class="component-bar"><span style="width:${clamp(item.score/item.max*100,0,100).toFixed(1)}%"></span></div></div>`).join('');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }

  function renderResults(vault, region, cohort, householdSize) {
    const stats = recentStats(vault);
    if (stats.transactionCount === 0 || stats.monthlyExpenses <= 0) throw new Error('Add recent expense transactions to the private planner before running the health comparison.');
    const balances = localBalanceStats(vault);
    const comparisons = compareGroups(stats, cohort);
    const score = scoreHealth(stats, balances, comparisons);
    const actions = buildActions(stats, balances, comparisons, score);

    $('healthScore').textContent = String(score.total);
    $('healthLabel').textContent = score.label;
    $('peerCohort').textContent = `${region.name} · ${cohort.label}`;
    const people = Number(cohort.averagePeople);
    $('peerPeople').textContent = Number.isFinite(people) && people > 0 ? `Peer consumer unit averages ${people.toFixed(1)} people${householdSize ? ` · your household: ${householdSize}` : ''}` : 'Household-size comparison unavailable';
    $('userMonthlySpend').textContent = money.format(stats.monthlyExpenses);
    $('trackedPeriod').textContent = `${stats.monthsObserved} observed month${stats.monthsObserved === 1 ? '' : 's'} in the last 90 days · ${stats.transactionCount} transactions`;
    $('peerMonthlySpend').textContent = money.format((Number(cohort.annualExpenditures)||0)/12);
    $('benchmarkPeriod').textContent = `BLS ${benchmarks.sourcePeriod} two-year mean`;
    $('runwayMetric').textContent = score.runway == null ? '—' : `${score.runway.toFixed(1)} mo`;
    const apr = Number(balances.highestAprDebt?.apr) || 0;
    $('aprMetric').textContent = balances.highestAprDebt ? `${apr.toFixed(2)}%` : 'None entered';
    $('aprDetail').textContent = balances.highestAprDebt ? `${balances.highestAprDebt.name || 'Debt'} · ${money.format(Number(balances.highestAprDebt.balance)||0)} balance` : 'No positive debt balance in vault';

    renderComparisons(comparisons);
    renderActions(actions);
    renderComponents(score.components);
    $('setupPanel').hidden = true;
    $('results').hidden = false;
    $('vaultPassphrase').value = '';
    window.scrollTo({ top:0, behavior:'smooth' });
  }

  async function analyze(event) {
    event.preventDefault();
    $('formError').textContent = '';
    const button = $('analyzeButton');
    button.disabled = true;
    button.textContent = 'Analyzing locally…';
    try {
      if (!benchmarks) throw new Error('The public peer benchmark is not available yet. Try again after the benchmark refresh completes.');
      const stateCode = $('stateSelect').value;
      const regionKey = REGION_BY_STATE[stateCode];
      const annualIncome = Number($('annualIncome').value);
      const householdSize = Number($('householdSize').value) || null;
      if (!regionKey || !Number.isFinite(annualIncome) || annualIncome <= 0) throw new Error('Choose a state and enter annual gross household income.');
      const { region, cohort } = selectCohort(regionKey, annualIncome);
      const db = await openDb();
      const record = await dbGet(db, VAULT_ID);
      db.close();
      if (!record) throw new Error('No encrypted finance vault was found on this device. Create or pair a vault in the Private Planner first.');
      const vault = await decryptVault(record, $('vaultPassphrase').value);
      renderResults(vault, region, cohort, householdSize);
    } catch (error) {
      console.error(error);
      $('formError').textContent = error?.name === 'OperationError' ? 'Could not decrypt the local vault. Check the passphrase and try again.' : (error.message || 'Could not analyze the local vault.');
      $('vaultPassphrase').value = '';
    } finally {
      button.disabled = false;
      button.textContent = 'Analyze my financial health';
    }
  }

  async function loadBenchmarks() {
    try {
      const response = await fetch('./benchmarks.json', { cache:'no-store', credentials:'same-origin' });
      if (!response.ok) throw new Error(`Benchmark HTTP ${response.status}`);
      const data = await response.json();
      if (!data?.regions?.west || !data?.sourcePeriod) throw new Error('Benchmark file is incomplete');
      benchmarks = data;
      $('benchmarkStatus').textContent = `BLS ${data.sourcePeriod} benchmark ready`;
    } catch (error) {
      console.error(error);
      $('benchmarkStatus').textContent = 'Benchmark refresh pending';
      $('benchmarkStatus').title = 'The public BLS benchmark file has not been generated yet.';
    }
  }

  function init() {
    $('stateSelect').insertAdjacentHTML('beforeend', STATES.map(([code,name]) => `<option value="${code}">${escapeHtml(name)}</option>`).join(''));
    $('healthForm').addEventListener('submit', analyze);
    $('changeProfileButton').addEventListener('click', () => {
      $('results').hidden = true;
      $('setupPanel').hidden = false;
      $('formError').textContent = '';
      window.scrollTo({ top:0, behavior:'smooth' });
    });
    loadBenchmarks();
  }

  init();
})();

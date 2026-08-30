(() => {
  'use strict';

  const API = 'https://billing.sharecapsule.org';
  const CANONICAL_ORIGIN = 'https://finance.sharecapsule.org';
  const DB_NAME = 'sharecapsule-private-finance';
  const DB_VERSION = 1;
  const STORE_NAME = 'vaults';
  const VAULT_ID = 'primary';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  let state = null;
  let localVaultFound = false;
  let authBlockedForOrigin = false;

  const featureLabels = {
    finance_vault: 'Private finance vault',
    basic_ticker_watch: 'Basic Ticker Watch',
    single_ticker_audio: 'Single-ticker audio',
    watchlist_sync: 'Encrypted watchlist sync',
    daily_watchlist_briefing: 'Whole-watchlist briefing',
    scheduled_briefing: 'Scheduled briefings',
    briefing_history: 'Briefing history',
    advanced_alerts: 'Advanced alerts'
  };

  function safeReturnPath(value) {
    const text = String(value || '').trim();
    if (!text.startsWith('/') || text.startsWith('//') || /[\r\n]/.test(text)) return '';
    return text;
  }

  function resolveReturnPath() {
    const explicit = safeReturnPath(params.get('return_to'));
    if (explicit && !explicit.startsWith('/account/')) return explicit;
    try {
      const referrer = new URL(document.referrer);
      if (referrer.origin === location.origin && !referrer.pathname.startsWith('/account/')) {
        return safeReturnPath(`${referrer.pathname}${referrer.search}${referrer.hash}`) || '/';
      }
    } catch (_) {}
    return '/';
  }

  const returnPath = resolveReturnPath();

  function showBanner(message, error = false) {
    const node = $('banner');
    if (!message) { node.hidden = true; node.textContent = ''; return; }
    node.textContent = message;
    node.classList.toggle('error', error);
    node.hidden = false;
  }

  function readLocalVault() {
    if (!window.indexedDB) return Promise.resolve(false);
    return new Promise((resolve) => {
      let upgraded = false;
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        upgraded = true;
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, {keyPath: 'id'});
      };
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        if (upgraded || !db.objectStoreNames.contains(STORE_NAME)) {
          db.close();
          resolve(false);
          return;
        }
        const get = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(VAULT_ID);
        get.onerror = () => { db.close(); resolve(false); };
        get.onsuccess = () => { const found = Boolean(get.result); db.close(); resolve(found); };
      };
    });
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      method: options.method || 'GET',
      headers: options.body ? {'Content-Type': 'application/json'} : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'include',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Account service returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function renderFeatures(features = {}) {
    $('featureList').innerHTML = Object.entries(featureLabels).map(([key, label]) => {
      const enabled = Boolean(features[key]);
      return `<div class="feature"><span>${label}</span><strong class="${enabled ? 'yes' : 'no'}">${enabled ? 'Included' : 'Plus'}</strong></div>`;
    }).join('');
  }

  function renderReturnButton(authenticated) {
    const button = $('returnButton');
    if (!button) return;
    button.hidden = !authenticated;
    if (returnPath.startsWith('/trade/')) button.textContent = 'Return to Ticker Watch';
    else if (localVaultFound) button.textContent = 'Open local finance vault';
    else button.textContent = 'Open finance planner';
  }

  function render(data) {
    state = data;
    const authenticated = Boolean(data.authenticated);
    const plus = data.plan === 'plus';
    $('signInButton').hidden = authenticated;
    $('signOutButton').hidden = !authenticated;
    $('manageButton').hidden = !authenticated || !data.subscription;
    $('monthlyButton').disabled = plus || authBlockedForOrigin;
    $('annualButton').disabled = plus || authBlockedForOrigin;
    $('plusState').textContent = plus ? 'Current plan' : 'Requires subscription';
    $('plusState').classList.toggle('active', plus);
    $('freeState').textContent = plus ? 'Included with Plus' : 'Current plan';
    $('freeState').classList.toggle('active', !plus);

    if (authenticated) {
      $('accountTitle').textContent = data.user?.name || data.user?.email || 'Signed in';
      const status = data.subscription?.status ? ` · subscription ${data.subscription.status}` : '';
      const vault = localVaultFound ? ' · encrypted vault found on this device' : ' · no local vault on this origin';
      $('accountDetail').textContent = `${data.user?.email || ''} · ${plus ? 'Plus' : 'Free'}${status}${vault}`;
    } else {
      $('accountTitle').textContent = authBlockedForOrigin ? 'Migrate this local vault before Google sign-in' : 'Sign in to manage Plus';
      $('accountDetail').textContent = localVaultFound
        ? 'Your encrypted finance vault is still stored in this browser. Google identity does not replace, upload or decrypt it.'
        : 'Google is used only to establish account identity. Your finance vault stays outside the account system.';
    }
    renderReturnButton(authenticated);
    renderFeatures(data.features || {});
  }

  function oauthReturnPath() {
    const query = new URLSearchParams({auth_return: '1'});
    if (returnPath && returnPath !== '/') query.set('return_to', returnPath);
    return `/account/?${query.toString()}`;
  }

  function protectOrigin() {
    if (location.origin === CANONICAL_ORIGIN) return false;
    if (!localVaultFound) return false;
    authBlockedForOrigin = true;
    $('signInButton').textContent = 'Return to vault and migrate records';
    showBanner(`Your encrypted vault is stored on ${location.origin}. Google sign-in is configured for ${CANONICAL_ORIGIN}, and browser vault storage does not cross origins. Your data is not lost. Return to Finance home, unlock the vault, use Privacy → Export all records, import that encrypted file on ${CANONICAL_ORIGIN}, then sign in.`, true);
    return true;
  }

  async function refresh() {
    try {
      const data = await api('/v1/me');
      render(data);
      if (data.authenticated && params.get('auth_return') === '1') {
        showBanner(localVaultFound
          ? 'Google sign-in is complete. Your encrypted vault stayed on this device and was not replaced. Continue back to your local data.'
          : 'Google sign-in is complete. Account identity is active. No local finance vault was found on this origin.');
      }
    } catch (error) {
      showBanner(`Account service unavailable: ${error.message}`, true);
      render({authenticated: false, plan: 'free', features: {finance_vault:true,basic_ticker_watch:true,single_ticker_audio:true,watchlist_sync:true}});
    }
  }

  function signIn() {
    if (authBlockedForOrigin) {
      location.href = '/';
      return;
    }
    location.href = `${API}/v1/auth/google/start?return_to=${encodeURIComponent(oauthReturnPath())}`;
  }

  async function checkout(interval) {
    if (authBlockedForOrigin) return signIn();
    if (!state?.authenticated) return signIn();
    showBanner(`Preparing ${interval} Plus checkout…`);
    $('monthlyButton').disabled = true;
    $('annualButton').disabled = true;
    try {
      const result = await api('/v1/checkout', {method: 'POST', body: {interval}});
      location.href = result.url;
    } catch (error) {
      showBanner(error.message, true);
      $('monthlyButton').disabled = false;
      $('annualButton').disabled = false;
    }
  }

  async function manageSubscription() {
    showBanner('Opening secure billing management…');
    try {
      const result = await api('/v1/portal', {method: 'POST'});
      location.href = result.url;
    } catch (error) { showBanner(error.message, true); }
  }

  async function signOut() {
    try { await api('/v1/logout', {method: 'POST'}); }
    catch (error) { console.warn(error); }
    location.reload();
  }

  $('signInButton').addEventListener('click', signIn);
  $('monthlyButton').addEventListener('click', () => checkout('monthly'));
  $('annualButton').addEventListener('click', () => checkout('annual'));
  $('manageButton').addEventListener('click', manageSubscription);
  $('signOutButton').addEventListener('click', signOut);
  $('returnButton').addEventListener('click', () => { location.href = returnPath || '/'; });

  async function init() {
    localVaultFound = await readLocalVault();
    if (protectOrigin()) {
      render({authenticated: false, plan: 'free', features: {finance_vault:true,basic_ticker_watch:true,single_ticker_audio:true,watchlist_sync:true}});
      return;
    }
    if (params.get('checkout') === 'success') showBanner('Checkout completed. Your Plus access will appear as soon as Stripe confirms the subscription.');
    if (params.get('checkout') === 'cancelled') showBanner('Checkout was cancelled. No subscription change was made.');
    if (params.get('auth') === 'failed') showBanner('Google sign-in did not complete. Please try again.', true);
    await refresh();
  }

  init();
})();

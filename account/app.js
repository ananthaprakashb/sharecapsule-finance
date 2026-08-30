(() => {
  'use strict';
  const API = 'https://billing.sharecapsule.org';
  const $ = (id) => document.getElementById(id);
  let state = null;

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

  function showBanner(message, error = false) {
    const node = $('banner');
    if (!message) { node.hidden = true; node.textContent = ''; return; }
    node.textContent = message;
    node.classList.toggle('error', error);
    node.hidden = false;
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

  function render(data) {
    state = data;
    const authenticated = Boolean(data.authenticated);
    const plus = data.plan === 'plus';
    $('signInButton').hidden = authenticated;
    $('signOutButton').hidden = !authenticated;
    $('manageButton').hidden = !authenticated || !data.subscription;
    $('monthlyButton').disabled = plus;
    $('annualButton').disabled = plus;
    $('plusState').textContent = plus ? 'Current plan' : 'Requires subscription';
    $('plusState').classList.toggle('active', plus);
    $('freeState').textContent = plus ? 'Included with Plus' : 'Current plan';
    $('freeState').classList.toggle('active', !plus);

    if (authenticated) {
      $('accountTitle').textContent = data.user?.name || data.user?.email || 'Signed in';
      const status = data.subscription?.status ? ` · subscription ${data.subscription.status}` : '';
      $('accountDetail').textContent = `${data.user?.email || ''} · ${plus ? 'Plus' : 'Free'}${status}`;
    } else {
      $('accountTitle').textContent = 'Sign in to manage Plus';
      $('accountDetail').textContent = 'Google is used only to establish account identity. Your finance vault stays outside the account system.';
    }
    renderFeatures(data.features || {});
  }

  async function refresh() {
    try { render(await api('/v1/me')); }
    catch (error) {
      showBanner(`Account service unavailable: ${error.message}`, true);
      render({authenticated: false, plan: 'free', features: {finance_vault:true,basic_ticker_watch:true,single_ticker_audio:true,watchlist_sync:true}});
    }
  }

  function signIn() {
    location.href = `${API}/v1/auth/google/start?return_to=${encodeURIComponent('/account/')}`;
  }

  async function checkout(interval) {
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

  const params = new URLSearchParams(location.search);
  if (params.get('checkout') === 'success') showBanner('Checkout completed. Your Plus access will appear as soon as Stripe confirms the subscription.');
  if (params.get('checkout') === 'cancelled') showBanner('Checkout was cancelled. No subscription change was made.');
  if (params.get('auth') === 'failed') showBanner('Google sign-in did not complete. Please try again.', true);
  refresh();
})();

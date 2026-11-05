/**
 * Finova — Personal Finance Dashboard Core Application
 * Full implementation strictly adhering to the Master Prompt specification.
 */

// =============================================================================
// SUPABASE — Config + Cloud Adapter (merged from supabase-config.js / supabase-adapter.js)
// =============================================================================
(function () {
  'use strict';

  // ── Public Supabase credentials (anon/publishable key — safe for the browser) ──
  const SUPABASE_URL     = 'https://yxxmsbvaebjdtkzxgyju.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_Cf8ZU8pq7RIrRr1s7QiaxQ_lMzTlFcG';

  // Guard: @supabase/supabase-js CDN must be loaded before script.js
  if (typeof window.supabase === 'undefined') {
    console.error('[FinovaCloud] @supabase/supabase-js is not loaded. Add the CDN <script> before script.js.');
    window.FinovaCloud = null;
    return;
  }

  const _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window._supabaseClient = _client; // expose for OTP

  // Debounce helper — prevents spamming cloud saves on rapid state changes
  function debounce(fn, wait) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // ── FinovaCloud public API ────────────────────────────────────────────────────
  const FinovaCloud = {
    /** Currently signed-in Supabase user enriched with role + name (null when signed out). */
    user: null,

    // ---- Auth ---------------------------------------------------------------

    /** Sign in with email + password. Resolves with enriched user { ...authUser, role, name }. */
    async signIn(email, password) {
      const { data, error } = await _client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return this._hydrateUser(data.user);
    },

    /** Create a new Supabase Auth account, then sign in automatically. */
    async signUp(email, password, displayName) {
      const { data, error } = await _client.auth.signUp({
        email,
        password,
        options: { data: { name: displayName } }
      });

      if (error) throw error;

      // Email confirmation required — session will be null
      if (!data.session) {
        throw new Error('A confirmation link was sent to ' + email + '. Verify your email then sign in.');
      }

      // Build a minimal user object from auth data (no profiles table needed)
      this.user = {
        ...data.user,
        role: 'user',
        name: displayName || data.user.email
      };
      return this.user;
    },

    /** Sign out and clear local user reference. */
    async signOut() {
      const { error } = await _client.auth.signOut();
      if (error) throw error;
      this.user = null;
    },

    // ---- State --------------------------------------------------------------

    /** Loaded version token — used for optimistic-locking saves. */
    _loadedVersion: null,

    /** Load finance state JSON from Supabase (finova_data table). Returns {} when no row exists yet. */
    async loadState() {
      if (!this.user) throw new Error('[FinovaCloud] Not authenticated');
      const { data, error } = await _client
        .from('finova_data').select('state, version').eq('user_id', this.user.id).maybeSingle();
      if (error) throw error;
      if (data) {
        this._loadedVersion = data.version;
        return data.state ?? {};
      }
      this._loadedVersion = null;
      return {};
    },

    /** Persist finance state (debounced 800 ms to coalesce rapid calls). */
    saveState(state) {
      if (!this.user) return;
      this._debouncedSave(state);
    },

    // ---- Internal -----------------------------------------------------------

    async _hydrateUser(authUser) {
      let profile = null;
      try {
        const { data } = await _client
          .from('profiles').select('role, name').eq('user_id', authUser.id).maybeSingle();
        profile = data;
        // fallback: try legacy 'id' column name
        if (!profile) {
          const { data: d2 } = await _client
            .from('profiles').select('role, name').eq('id', authUser.id).maybeSingle();
          profile = d2;
        }
      } catch (_) { /* profiles table missing or inaccessible — fall back to metadata */ }
      this.user = {
        ...authUser,
        role: profile?.role ?? 'user',
        name: profile?.name ?? authUser.user_metadata?.name ?? authUser.email
      };
      return this.user;
    },

    _debouncedSave: null,
    _initDebouncedSave() {
      if (this._debouncedSave) return;
      this._debouncedSave = debounce(async (state) => {
        if (!this.user) return;
        const uid = this.user.id;
        const loadedVersion = this._loadedVersion;

        if (loadedVersion !== null) {
          // Optimistic-lock update: only overwrites if version still matches
          const { data, error } = await _client
            .from('finova_data')
            .update({ state: state })
            .eq('user_id', uid)
            .eq('version', loadedVersion)
            .select('version');
          if (error) {
            console.warn('[FinovaCloud] saveState error:', error.message);
          } else if (data && data.length > 0) {
            this._loadedVersion = data[0].version;
          } else {
            console.warn('[FinovaCloud] saveState: version conflict — row was updated elsewhere.');
          }
        } else {
          // No version yet — insert a fresh row
          const { data, error } = await _client
            .from('finova_data')
            .insert({ user_id: uid, state: state })
            .select('version');
          if (error) {
            console.warn('[FinovaCloud] saveState insert error:', error.message);
          } else if (data && data.length > 0) {
            this._loadedVersion = data[0].version;
          }
        }
      }, 800);
    }
  };

  FinovaCloud._initDebouncedSave();
  window.FinovaCloud = FinovaCloud;

  // Auto-restore session when the page is refreshed
  _client.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      try { await FinovaCloud._hydrateUser(session.user); }
      catch (e) { console.warn('[FinovaCloud] session restore failed:', e); }
    } else if (event === 'SIGNED_OUT') {
      FinovaCloud.user = null;
    }
  });

  console.log('[FinovaCloud] ready —', SUPABASE_URL);
})();

// =============================================================================
// 1. Initial State & Store (Section 3: Empty-Start Contract)
// =============================================================================
const STORAGE_KEY = 'finova_private_finance_store';

const DEFAULT_CATEGORIES = [
  'Housing', 'Groceries', 'Shopping', 'Dining', 'Transportation', 
  'Utilities', 'Subscriptions', 'Insurance', 'Health', 'Entertainment', 
  'Income', 'Needs review', 'Other'
];

const DEFAULT_ACCOUNTS = [
  'Main Checking', 'Everyday Visa', 'Rewards Card', 'Cash'
];

const SUBSCRIPTION_HINTS = [
  'netflix', 'spotify', 'hulu', 'disney', 'youtube', 'icloud', 'dropbox', 
  'adobe', 'microsoft', 'amazon prime', 'patreon', 'membership', 'studio', 
  'gym', 'openai', 'chatgpt', 'canva', 'notion', 'zoom', 'slack', 'github'
];

const RECURRING_HINTS = [
  'mortgage', 'rent', 'loan', 'insurance', 'utility', 'utilities', 'electric', 
  'water', 'internet', 'phone', 'mobile', 'daycare', 'tuition', 'lease', 
  'car payment', 'auto payment', 'hoa', 'property tax'
];

const INITIAL_STATE = {
  transactions: [],
  documents: [],
  goals: [],
  budgets: [],
  subscriptions: [],
  recurring: [],
  dismissedPatterns: [],
  selectedPeriod: 'all-time',
  netWorthConfigured: false,
  assetsTotal: 0,
  liabilitiesTotal: 0,
  categories: [...DEFAULT_CATEGORIES],
  accounts: [...DEFAULT_ACCOUNTS],
  driveSync: {
    folderName: 'Finova Financial Inbox',
    schedule: 'Daily at 08:00 AM',
    lastSync: null,
    processedFileIds: [],
    driveResetAt: null
  }
};

class FinovaStore {
  constructor() {
    this.key = null; // set per account via switchTo()
    this.state = this.loadState();
  }

  loadState() {
    try {
      const data = this.key ? localStorage.getItem(this.key) : null;
      if (data) {
        const parsed = JSON.parse(data);
        return {
          ...INITIAL_STATE,
          ...parsed,
          categories: parsed.categories?.length ? parsed.categories : [...DEFAULT_CATEGORIES],
          accounts: parsed.accounts?.length ? parsed.accounts : [...DEFAULT_ACCOUNTS]
        };
      }
    } catch (e) {
      console.error('Failed to load state from localStorage:', e);
    }
    return JSON.parse(JSON.stringify(INITIAL_STATE));
  }

  saveState() {
    try {
      if (!this.key) return;
      localStorage.setItem(this.key, JSON.stringify(this.state));
      // Cloud sync (debounced inside FinovaCloud)
      if (typeof FinovaCloud !== 'undefined' && FinovaCloud.user) {
        FinovaCloud.saveState(this.state);
      }
    } catch (e) {
      console.error('Failed to save state to localStorage:', e);
      showToast('Storage quota exceeded or unavailable', 'error');
    }
  }

  // Load the data of a specific account (each account has its own data)
  switchTo(accountId) {
    this.key = STORAGE_KEY + '_' + accountId;
    this.state = this.loadState();
  }

  // Create unique transaction fingerprint (Section 4.4)
  generateFingerprint(date, merchant, amount, account) {
    return `${date}|${merchant.trim().toLowerCase()}|${Number(amount).toFixed(2)}|${account.trim().toLowerCase()}`;
  }

  // Add a single or batch of transactions with duplicate fingerprint check
  addTransactions(txList) {
    let inserted = 0;
    let duplicates = 0;
    const existingFingerprints = new Set(this.state.transactions.map(t => t.fingerprint));

    txList.forEach(raw => {
      const date = raw.date || new Date().toISOString().split('T')[0];
      const merchant = (raw.merchant || '').trim();
      const amount = Math.abs(parseFloat(raw.amount) || 0);
      const type = raw.type === 'income' ? 'income' : 'expense';
      let category = raw.category || 'Needs review';
      const account = (raw.account || 'Main Checking').trim();
      let tags = Array.isArray(raw.tags) ? raw.tags : [];

      if (!merchant || amount <= 0) return;

      const fp = this.generateFingerprint(date, merchant, amount, account);

      if (existingFingerprints.has(fp)) {
        duplicates++;
        return;
      }

      const tx = {
        id: 'tx_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
        date,
        merchant,
        category,
        amount,
        type,
        account,
        tags,
        receipt: !!raw.receipt,
        source: raw.source || 'manual',
        fingerprint: fp,
        createdAt: new Date().toISOString()
      };

      this.state.transactions.push(tx);
      existingFingerprints.add(fp);
      inserted++;
    });

    // Sort newest date first
    this.state.transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    this.saveState();
    return { inserted, duplicates };
  }

  updateTransaction(id, patch) {
    const tx = this.state.transactions.find(t => t.id === id);
    if (tx) {
      Object.assign(tx, patch);
      this.saveState();
      return true;
    }
    return false;
  }

  deleteTransaction(id) {
    const idx = this.state.transactions.findIndex(t => t.id === id);
    if (idx !== -1) {
      this.state.transactions.splice(idx, 1);
      this.saveState();
      return true;
    }
    return false;
  }

  // Complete Data Wipe (Section 16.5 & Section 4.7)
  wipeAllData() {
    this.state = JSON.parse(JSON.stringify(INITIAL_STATE));
    this.state.driveSync.driveResetAt = new Date().toISOString();
    this.state.selectedPeriod = 'all-time';
    this.saveState();
  }
}

// Global Store Instance
const store = new FinovaStore();

// Accounts (Admin / User) & preferences
const ACCOUNTS_KEY = 'finova_accounts';
const PREFS_KEY = 'finova_prefs';
const PERIODS = ['all-time', 'this-week', 'this-month', 'this-year'];
const CURRENCIES = {
  USD: 'US Dollar', PHP: 'Philippine Peso', EUR: 'Euro', GBP: 'British Pound', JPY: 'Japanese Yen',
  AUD: 'Australian Dollar', CAD: 'Canadian Dollar', SGD: 'Singapore Dollar', KRW: 'South Korean Won'
};

const accounts = {
  list: [],
  current: null,
  load() {
    try {
      const p = JSON.parse(localStorage.getItem(ACCOUNTS_KEY));
      if (p && p.list && p.list.length) {
        this.list = p.list;
        this.current = p.current;
        // Accounts created before passwords existed get a default one
        // Also force-update admin password if changed in code
        const newAdminHash = hashPass('finova4321');
        let changed = false;
        this.list.forEach(a => {
          if (!a.pass) {
            a.pass = hashPass(a.role === 'admin' ? 'finova4321' : 'user');
            changed = true;
          } else if (a.id === 'acc_admin' && a.pass !== newAdminHash) {
            a.pass = newAdminHash;
            changed = true;
          }
        });
        if (changed) this.save();
        return;
      }
    } catch (e) {}
    this.list = [
      { id: 'acc_admin', name: 'Admin', role: 'admin', pass: hashPass('finova4321') },
      { id: 'acc_user', name: 'User', role: 'user', pass: hashPass('user') }
    ];
    // Move data saved by the old single-profile version into the Admin account
    const legacy = localStorage.getItem(STORAGE_KEY);
    if (legacy) localStorage.setItem(STORAGE_KEY + '_acc_admin', legacy);
    this.save();
  },
  save() { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify({ list: this.list, current: this.current })); },
  get() { return this.list.find(a => a.id === this.current) || null; },
  role() {
    if (this.get()) return this.get().role;
    if (typeof FinovaCloud !== 'undefined' && FinovaCloud.user) return FinovaCloud.user.role || 'user';
    return 'user';
  }
};

const prefs = { lang: 'en', currency: 'USD' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) {}
function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }

// =============================================================================
// 2. Application UI Controller
// =============================================================================
// =============================================================================
// Real-Time Currency Exchange & Live Market Rates Service
// =============================================================================
const DEFAULT_RATES = {
  USD: 1,
  PHP: 58.45,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 154.20,
  AUD: 1.52,
  CAD: 1.38,
  SGD: 1.34,
  KRW: 1378.50
};

class LiveRatesService {
  constructor() {
    this.rates = Object.assign({}, DEFAULT_RATES);
    this.lastUpdated = null;
    this.status = 'idle'; // 'live', 'cached', 'fetching', 'offline'
    this.timer = null;
    this.listeners = [];
  }

  init() {
    this.loadCache();
    this.fetchLiveRates();
    if (this.timer) clearInterval(this.timer);
    // Real-time auto-sync every 60 seconds
    this.timer = setInterval(() => this.fetchLiveRates(), 60000);
  }

  loadCache() {
    try {
      const cached = JSON.parse(localStorage.getItem('finova_live_rates'));
      if (cached && cached.rates) {
        this.rates = Object.assign({}, DEFAULT_RATES, cached.rates);
        if (cached.lastUpdated) this.lastUpdated = new Date(cached.lastUpdated);
        this.status = 'cached';
      }
    } catch (e) {}
  }

  saveCache() {
    try {
      localStorage.setItem('finova_live_rates', JSON.stringify({
        rates: this.rates,
        lastUpdated: this.lastUpdated ? this.lastUpdated.toISOString() : null
      }));
    } catch (e) {}
  }

  async fetchLiveRates() {
    this.status = 'fetching';
    this.notify();

    const endpoints = [
      'https://open.er-api.com/v6/latest/USD',
      'https://api.exchangerate-api.com/v4/latest/USD',
      'https://api.frankfurter.dev/v1/latest?base=USD'
    ];

    let success = false;
    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) continue;
        const data = await res.json();
        const incoming = data.rates || data.conversion_rates;
        if (incoming && typeof incoming === 'object') {
          this.rates = Object.assign({}, this.rates, incoming);
          this.lastUpdated = new Date();
          this.status = 'live';
          this.saveCache();
          success = true;
          break;
        }
      } catch (err) {}
    }

    if (!success) {
      this.status = this.lastUpdated ? 'cached' : 'offline';
    }

    this.notify();
    return success;
  }

  onChange(cb) {
    this.listeners.push(cb);
  }

  notify() {
    this.listeners.forEach(cb => {
      try { cb(this); } catch (e) {}
    });
  }

  getRate(curr) {
    return this.rates[curr] || 1;
  }
}

const liveRatesService = new LiveRatesService();

class FinovaApp {
  constructor() {
    this.activeTab = 'dashboard';
    this.selectedPeriod = 'all-time';
    this.cashFlowChart = null;
    this.donutChart = null;
    this.pendingCsvData = null;

    this.init();
  }

  init() {
    this.bindEvents();
    this.applyPrefsUI();
    this.populateDropdowns();
    this.setPeriod(this.selectedPeriod, false);
    this.renderAll();
    this.refreshIcons();
    this.i18nObserve();
    if (window.Chart) { Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; Chart.defaults.font.size = 12; Chart.defaults.color = '#5a6480'; }

    // Real-Time Currency Exchange & Market API
    liveRatesService.init();
    liveRatesService.onChange(() => {
      this.renderLiveMarketUI();
    });

    // Live clock — ticks every second, no refresh needed
    this.startLiveClock();
  }

  startLiveClock() {
    const tickClock = () => {
      const now = new Date();

      // Topbar clock (HH:MM:SS)
      const clockEl = document.getElementById('topbarClockTime');
      if (clockEl) {
        clockEl.textContent = now.toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
      }

      // Live market time stamp — shows current time when rates are live
      const marketTimeEl = document.getElementById('liveMarketTime');
      if (marketTimeEl) {
        if (liveRatesService.lastUpdated) {
          const secAgo = Math.round((now - liveRatesService.lastUpdated) / 1000);
          if (secAgo < 60) {
            marketTimeEl.textContent = `Updated ${secAgo}s ago`;
          } else if (secAgo < 3600) {
            marketTimeEl.textContent = `Updated ${Math.floor(secAgo / 60)}m ago`;
          } else {
            marketTimeEl.textContent = `Updated at ${liveRatesService.lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          }
        } else {
          marketTimeEl.textContent = 'Auto-refresh: 60s';
        }
      }
    };

    tickClock();                        // run immediately
    setInterval(tickClock, 1000);       // then every second
  }

  refreshIcons() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // ===========================================================================
  // Event Binding
  // ===========================================================================
  bindEvents() {
    // Navigation Tabs (Sidebar + Mobile Bottom Nav)
    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        this.closeMenu();
        this.navigateToTab(tab);
      });
    });

    // Dashboard Period Selector Buttons
    document.querySelectorAll('#dashboardPeriodSelector .period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.getAttribute('data-period');
        this.setPeriod(p, true);
      });
    });

    // Transactions Period Filter Dropdown (Shared)
    const txPeriodSelect = document.getElementById('txPeriodFilter');
    if (txPeriodSelect) {
      txPeriodSelect.addEventListener('change', (e) => {
        this.setPeriod(e.target.value, true);
      });
    }

    // Top Action Buttons
    document.getElementById('btnTopAddEntry').addEventListener('click', () => this.openAddEntryModal());
    document.getElementById('btnTopImport').addEventListener('click', () => this.openImportModal());
    document.getElementById('btnTopDriveSync').addEventListener('click', () => this.openDriveSyncModal());
    document.getElementById('btnDemoToggle').addEventListener('click', () => this.toggleDemoData());

    // Dashboard View All Transactions
    document.getElementById('btnViewAllTransactions')?.addEventListener('click', () => {
      this.navigateToTab('transactions');
    });

    // Net worth link
    document.getElementById('btnConfigNetWorth')?.addEventListener('click', () => {
      this.navigateToTab('settings');
      const input = document.getElementById('settingAssetsInput');
      if (input) input.focus();
    });

    // Transactions Filters
    document.getElementById('txSearchInput')?.addEventListener('input', () => this.renderTransactions());
    document.getElementById('txCategoryFilter')?.addEventListener('change', () => this.renderTransactions());
    document.getElementById('txAccountFilter')?.addEventListener('change', () => this.renderTransactions());
    document.getElementById('btnResetFilters')?.addEventListener('click', () => {
      document.getElementById('txSearchInput').value = '';
      document.getElementById('txCategoryFilter').value = '';
      document.getElementById('txAccountFilter').value = '';
      this.renderTransactions();
    });

    // Add Entry Form Submit & Controls
    this.bindAddEntryForm();

    // CSV & Document Import Handlers
    this.bindImportModal();

    // Budget & Goals Handlers
    this.bindBudgetAndGoalForms();

    // Recurring & Subscription Handlers
    this.bindRecurringAndSubForms();

    // Sliding menu, accounts, language & currency
    this.bindShell();

    // Settings & Net Worth
    this.bindSettings();

    // Modal Close buttons (data-close-modal) & Escape key
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => this.closeAllModals());
    });

    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeAllModals();
      });
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.closeAllModals(); this.closeMenu(); }
    });
  }

  // ===========================================================================
  // Shell: sliding menu, account switching, role UI, preferences
  // ===========================================================================
  openMenu() { document.body.classList.add('menu-open'); }
  closeMenu() { document.body.classList.remove('menu-open'); }

  bindShell() {
    document.getElementById('btnMenu')?.addEventListener('click', () => document.body.classList.toggle('menu-open'));
    document.getElementById('menuOverlay')?.addEventListener('click', () => this.closeMenu());
    document.getElementById('btnSwitchAccount')?.addEventListener('click', () => {
      this.closeMenu();
      this.showAccountScreen();
    });
    document.querySelectorAll('#settingLanguage,#authLangSelect').forEach(s => s.addEventListener('change', e => this.setLanguage(e.target.value)));
    document.getElementById('settingCurrency')?.addEventListener('change', e => this.setCurrency(e.target.value));
    document.getElementById('btnRefreshRates')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnRefreshRates');
      btn?.classList.add('spinning');
      const ok = await liveRatesService.fetchLiveRates();
      btn?.classList.remove('spinning');
      if (ok) {
        showToast('Real-time market rates updated via Live API', 'success');
      } else {
        showToast('Live API checked. Using cached rates.', 'info');
      }
    });

    // Auth screen tabs & forms
    document.getElementById('tabBtnSignIn')?.addEventListener('click', () => this.switchAuthTab('signin'));
    document.getElementById('tabBtnSignUp')?.addEventListener('click', () => this.switchAuthTab('signup'));
    document.getElementById('linkGoToSignIn')?.addEventListener('click', e => { e.preventDefault(); this.switchAuthTab('signin'); });
    document.getElementById('linkGoToSignUpFromIn')?.addEventListener('click', e => { e.preventDefault(); this.switchAuthTab('signup'); });
    document.getElementById('formAuthSignIn')?.addEventListener('submit', e => this.submitAuthSignIn(e));
    document.getElementById('formAuthSignUp')?.addEventListener('submit', e => this.submitAuthSignUp(e));
    document.getElementById('btnToggleLoginPass')?.addEventListener('click', () => {
      const el = document.getElementById('authLoginPass');
      if (el) el.type = el.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('btnToggleRegisterPass')?.addEventListener('click', () => {
      const el = document.getElementById('authRegisterPass');
      if (el) el.type = el.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('btnAuthToSwitch')?.addEventListener('click', () => this.showAccountScreen());

    document.getElementById('btnSwitchToSignIn')?.addEventListener('click', () => this.showAuthScreen());
    document.getElementById('btnBackFromSwitch')?.addEventListener('click', () => {
      document.getElementById('accountScreen')?.classList.remove('active');
      if (accounts.current) {
        const cur = accounts.get();
        if (cur) {
          document.body.classList.remove('role-admin', 'role-user');
          document.body.classList.add('authed', 'role-' + cur.role);
          this.renderDrawerAccount();
          if (!this.activeTab || (cur.role === 'admin' && !this.activeTab.startsWith('admin-') && this.activeTab !== 'documents' && this.activeTab !== 'settings')) {
            this.navigateToTab(cur.role === 'admin' ? 'admin-dashboard' : 'dashboard');
          }
        } else {
          document.body.classList.add('authed');
        }
      } else {
        this.showAuthScreen();
      }
    });

    // Old login verification modal (used in account switcher)
    document.getElementById('formLogin')?.addEventListener('submit', e => { e.preventDefault(); this.submitLogin(); });
    
    document.getElementById('btnLoginCancel')?.addEventListener('click', () => this.showAccountScreen());

    const addForm = document.getElementById('formAddAccount');
    addForm?.addEventListener('submit', e => {
      e.preventDefault();
      const name = document.getElementById('newAccName').value.trim();
      const role = document.getElementById('newAccRole')?.value || 'user';
      if (!name) return;
      accounts.list.push({ id: 'acc_' + Date.now().toString(36), name, role, pass: hashPass(document.getElementById('newAccPass').value) });
      accounts.save();
      addForm.reset();
      addForm.style.display = 'none';
      this.renderAccountGrid();
      showToast(`Account "${name}" created`, 'success');
    });
    document.getElementById('btnCancelAddAccount')?.addEventListener('click', () => {
      addForm.reset();
      addForm.style.display = 'none';
    });
  }

  // First load: splash -> modern Login & Sign In UI
  boot() {
    accounts.load();
    setTimeout(() => {
      this.hideSplash();
      this.showAuthScreen();
    }, 1000);
  }

  showSplash(text) {
    document.getElementById('splashText').textContent = text;
    document.getElementById('splash').classList.add('active');
  }

  hideSplash() { document.getElementById('splash').classList.remove('active'); }

  showAuthScreen() {
    document.body.classList.remove('authed', 'menu-open');
    document.getElementById('accountScreen')?.classList.remove('active');
    document.getElementById('loginScreen')?.classList.remove('active');
    document.getElementById('authScreen')?.classList.add('active');
    const errIn = document.getElementById('authLoginError');
    const errUp = document.getElementById('authRegisterError');
    if (errIn) errIn.textContent = '';
    if (errUp) errUp.textContent = '';
    this.switchAuthTab('signin');
    this.refreshIcons();
    setTimeout(() => document.getElementById('authLoginUser')?.focus(), 100);
  }

  switchAuthTab(tab) {
    const isSignIn = tab === 'signin';
    document.getElementById('tabBtnSignIn')?.classList.toggle('active', isSignIn);
    document.getElementById('tabBtnSignUp')?.classList.toggle('active', !isSignIn);
    const formSignIn = document.getElementById('formAuthSignIn');
    const formSignUp = document.getElementById('formAuthSignUp');
    if (formSignIn) formSignIn.style.display = isSignIn ? 'block' : 'none';
    if (formSignUp) formSignUp.style.display = !isSignIn ? 'block' : 'none';
    const errIn = document.getElementById('authLoginError');
    const errUp = document.getElementById('authRegisterError');
    if (errIn) errIn.textContent = '';
    if (errUp) errUp.textContent = '';
    this.refreshIcons();
  }

  async submitAuthSignIn(e) {
    if (e) e.preventDefault();
    const userInput = document.getElementById('authLoginUser').value.trim();
    const passInput = document.getElementById('authLoginPass').value;
    const errEl = document.getElementById('authLoginError');
    if (errEl) errEl.textContent = '';

    if (!userInput) {
      if (errEl) errEl.textContent = 'Please enter your account name or Gmail address.';
      return;
    }

    if (window.FinovaCloud && /\S+@\S+\.\S+/.test(userInput)) {
      try {
        const user = await FinovaCloud.signIn(userInput, passInput);
        document.getElementById('authScreen')?.classList.remove('active');
        this.enterAccountCloud(user);
        return;
      } catch (err) {
        if (errEl) errEl.textContent = err.message || 'Sign-in failed.';
        return;
      }
    }

    // --- Fallback: local account lookup (admin / username login) ---
    const acc = accounts.list.find(a => a.name.toLowerCase() === userInput.toLowerCase() || (a.email || '').toLowerCase() === userInput.toLowerCase());
    if (!acc) {
      if (errEl) errEl.textContent = 'Account not found. Check your account name or Gmail address.';
      return;
    }

    if (hashPass(passInput) !== acc.pass) {
      let legacyH = 5381;
      for (const c of 'ledgerly:' + passInput) legacyH = ((legacyH << 5) + legacyH + c.charCodeAt(0)) >>> 0;
      if (legacyH.toString(16) === acc.pass) {
        acc.pass = hashPass(passInput);
        accounts.save();
      } else {
        if (errEl) errEl.textContent = 'Incorrect password.';
        return;
      }
    }

    if (acc.active === false) { if (errEl) errEl.textContent = 'This account is deactivated. Please contact an admin.'; return; }
    document.getElementById('authScreen')?.classList.remove('active');
    this.enterAccount(acc.id);
  }

  async submitAuthSignUp(e) {
    if (e) e.preventDefault();
    const name  = document.getElementById('authRegisterUser').value.trim();
    const pass  = document.getElementById('authRegisterPass').value;
    const email = (document.getElementById('authRegisterEmail')?.value || '').trim();
    const errEl = document.getElementById('authRegisterError');
    if (errEl) errEl.textContent = '';

    if (!name) { if (errEl) errEl.textContent = 'Please enter an account name.'; return; }
    if (!/^[^\s@]+@gmail\.com$/i.test(email)) { if (errEl) errEl.textContent = 'Please enter a valid Gmail address (name@gmail.com).'; return; }
    if (pass.length < 6) { if (errEl) errEl.textContent = 'Password must be at least 6 characters.'; return; }

    // --- Supabase cloud sign-up ---
    if (window.FinovaCloud) {
      try {
        const user = await FinovaCloud.signUp(email, pass, name);
        showToast(`Welcome, ${name}! Your account is ready.`, 'success');
        document.getElementById('formAuthSignUp').reset();
        document.getElementById('authScreen')?.classList.remove('active');
        this.enterAccountCloud(user);
        return;
      } catch (err) {
        const msg = err.message || '';
        // Email confirmation required — show friendly info and switch to sign-in
        if (msg.includes('confirmation email') || msg.includes('confirm')) {
          showToast(msg, 'info');
          document.getElementById('formAuthSignUp').reset();
          document.getElementById('authLoginUser').value = email;
          this.switchAuthTab('signin');
          return;
        }
        if (errEl) errEl.textContent = msg || 'Sign-up failed. Please try again.';
        return;
      }
    }

    // --- Fallback: local account creation ---
    if (accounts.list.some(a => a.name.toLowerCase() === name.toLowerCase())) {
      if (errEl) errEl.textContent = 'An account with this name already exists.'; return;
    }
    if (accounts.list.some(a => (a.email || '').toLowerCase() === email.toLowerCase())) {
      if (errEl) errEl.textContent = 'This Gmail is already registered.'; return;
    }
    const newAcc = { id: 'acc_' + Date.now().toString(36), name, role: 'user', pass: hashPass(pass), email, active: true };
    accounts.list.push(newAcc);
    accounts.save();
    showToast(`Welcome, ${name}! Your account is ready.`, 'success');
    document.getElementById('formAuthSignUp').reset();
    document.getElementById('authScreen')?.classList.remove('active');
    this.enterAccount(newAcc.id);
  }

  showAccountScreen() {
    document.body.classList.remove('menu-open');
    document.getElementById('authScreen')?.classList.remove('active');
    document.getElementById('loginScreen')?.classList.remove('active');
    this.renderAccountGrid();

    const backBtn = document.getElementById('btnBackFromSwitch');
    const backText = document.getElementById('btnBackFromSwitchText');
    if (accounts.current) {
      if (backBtn) backBtn.style.display = 'inline-flex';
      if (backText) backText.textContent = 'Back to App';
    } else {
      if (backBtn) backBtn.style.display = 'inline-flex';
      if (backText) backText.textContent = 'Back to Sign In';
    }

    document.getElementById('accountScreen')?.classList.add('active');
    this.refreshIcons();
  }
  renderAccountGrid() {
    const grid = document.getElementById('accountGrid');
    grid.innerHTML = '';
    accounts.list.forEach(acc => {
      const isCurrent = acc.id === accounts.current;
      const isAdmin = acc.role === 'admin' || acc.id === 'acc_admin';
      const card = document.createElement('div');
      card.className = 'account-card' + (isCurrent ? ' current' : '') + (isAdmin ? ' is-admin' : '');
      card.innerHTML = `
        <button class="account-pick" type="button">
          <span class="avatar" style="background:${avatarColor(acc.name)}">${escapeHTML(acc.name.charAt(0).toUpperCase())}</span>
          <strong class="account-name">${escapeHTML(acc.name)}</strong>
          <span class="role-badge ${acc.role}">${acc.role === 'admin' ? 'Admin' : 'User'}</span>
          ${isCurrent ? '<span class="account-current">Current</span>' : ''}
        </button>
        ${isAdmin ? '' : '<button class="account-remove" type="button" title="Remove account"><i data-lucide="x"></i></button>'}
      `;
      card.querySelector('.account-pick').addEventListener('click', () => this.showLogin(acc));
      card.querySelector('.account-remove')?.addEventListener('click', () => this.removeAccount(acc));
      grid.appendChild(card);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'account-card account-add';
    add.innerHTML = `<span class="avatar avatar-add"><i data-lucide="plus"></i></span><strong class="account-name">Add account</strong>`;
    add.addEventListener('click', () => {
      document.getElementById('formAddAccount').style.display = 'flex';
      document.getElementById('newAccName').focus();
    });
    grid.appendChild(add);
    this.refreshIcons();
  }

  // Login step shown after choosing an account
  showLogin(acc, verified) {
    this.loginAcc = acc;
    this.loginVerified = !!verified;
    document.getElementById('authScreen')?.classList.remove('active');
    document.getElementById('accountScreen')?.classList.remove('active');
    document.getElementById('loginScreen')?.classList.remove('active');
    document.getElementById('loginScreen').classList.add('active');
    document.getElementById('loginUser').value = acc.name;
    
    document.getElementById('loginPass').value = '';
    
    document.getElementById('loginError').textContent = '';
    
    this.refreshIcons();
    document.getElementById('loginPass').focus();
  }

  submitLogin() {
    const acc = this.loginAcc;
    if (!acc) return;
    const pass = document.getElementById('loginPass').value;
    

    if (acc.active === false) return this.loginFail('This account is deactivated.');
    if (!this.loginVerified && hashPass(pass) !== acc.pass) return this.loginFail('Incorrect password.');
    

    document.getElementById('loginScreen').classList.remove('active');
    this.enterAccount(acc.id); // shows "Loading Admin/User interface..."
  }

  loginFail(message) {
    document.getElementById('loginError').textContent = message;
    document.getElementById('loginPass').value = '';
    
    const card = document.getElementById('formLogin');
    card.classList.remove('shake');
    void card.offsetWidth; // restart the animation
    card.classList.add('shake');
    
    document.getElementById('loginPass').focus();
  }

  // Random 5-character code drawn on a canvas with noise (like the sample login)
  drawCaptcha() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    this.captchaCode = code;

    const cv = document.getElementById('captchaCanvas');
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.fillStyle = '#0f1530';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i++) {
      ctx.strokeStyle = `hsla(${Math.random() * 360}, 60%, 60%, 0.7)`;
      ctx.beginPath();
      ctx.moveTo(Math.random() * w, Math.random() * h);
      ctx.lineTo(Math.random() * w, Math.random() * h);
      ctx.stroke();
    }
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `hsla(${Math.random() * 360}, 70%, 65%, 0.8)`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    ctx.font = 'bold 26px Georgia';
    ctx.textBaseline = 'middle';
    [...code].forEach((ch, i) => {
      ctx.save();
      ctx.translate(16 + i * 27, h / 2 + (Math.random() * 8 - 4));
      ctx.rotate((Math.random() - 0.5) * 0.5);
      ctx.fillStyle = '#c7d0ff';
      ctx.fillText(ch, -8, 0);
      ctx.restore();
    });
  }

  removeAccount(acc) {
    if (acc.role === 'admin' || acc.id === 'acc_admin') { showToast('Admin account cannot be removed', 'error'); return; }
    const admins = accounts.list.filter(a => a.role === 'admin');
    if (acc.role === 'admin' && admins.length === 1) {
      showToast('At least one Admin account is required', 'error');
      return;
    }
    if (!confirm(`Remove account "${acc.name}" and all of its data?`)) return;
    accounts.list = accounts.list.filter(a => a.id !== acc.id);
    localStorage.removeItem(STORAGE_KEY + '_' + acc.id);
    if (accounts.current === acc.id) accounts.current = null;
    accounts.save();
    this.renderAccountGrid();
  }

  // Loading screen, then the Admin or User interface
  enterAccount(id) {
    const acc = accounts.list.find(a => a.id === id);
    if (!acc) return;
    document.getElementById('authScreen')?.classList.remove('active');
    document.getElementById('accountScreen')?.classList.remove('active');
    document.getElementById('loginScreen')?.classList.remove('active');
    this.showSplash(acc.role === 'admin' ? 'Loading Admin interface...' : 'Loading User interface...');

    setTimeout(() => {
      accounts.current = id;
      accounts.save();
      store.switchTo(id);

      const saved = store.state.selectedPeriod;
      this.selectedPeriod = PERIODS.includes(saved) ? saved : 'all-time';

      document.body.classList.remove('role-admin', 'role-user');
      document.body.classList.add('authed', 'role-' + acc.role);
      this.renderDrawerAccount();
      this.setPeriod(this.selectedPeriod, false);
      this.navigateToTab(acc.role === 'admin' ? 'admin-dashboard' : 'dashboard');
      this.hideSplash();
    }, 1400);
  }

  // Cloud sign-in entry point (Supabase user object)
  enterAccountCloud(user) {
    const role = user.role || 'user';
    const name = user.user_metadata?.name || user.email || 'User';

    // Check if this cloud user has been terminated by admin
    if (role !== 'admin') {
      const record = accounts.list.find(x => x.id === user.id);
      if (record && record.terminated) {
        showToast('Your account has been terminated. Contact the admin.', 'error');
        if (window._supabaseClient) window._supabaseClient.auth.signOut();
        return;
      }
    }

    document.getElementById('authScreen')?.classList.remove('active');
    document.getElementById('accountScreen')?.classList.remove('active');
    document.getElementById('loginScreen')?.classList.remove('active');
    this.showSplash(role === 'admin' ? 'Loading Admin interface...' : 'Loading User interface...');

    const finish = (cloudState) => {
      // Use the Supabase UUID as the storage key so data is user-scoped
      store.switchTo(user.id);
      if (cloudState && Object.keys(cloudState).length > 0) {
        store.state = { ...store.state, ...cloudState };
      }

      const saved = store.state.selectedPeriod;
      this.selectedPeriod = PERIODS.includes(saved) ? saved : 'all-time';

      // Clear local accounts.current so accounts.role() does NOT pick up
      // a stale local admin entry and override the cloud user's role.
      accounts.current = null;
      // Do NOT call accounts.save() here — we don't want to wipe the local
      // admin session from localStorage for non-cloud logins.

      document.body.classList.remove('role-admin', 'role-user');
      document.body.classList.add('authed', 'role-' + role);

      // Inject a synthetic account entry so renderDrawerAccount() works
      accounts._cloudUser = { id: user.id, name, role };

      // Register cloud user in accounts.list so admin panel can see them
      if (role !== 'admin') {
        const existing = accounts.list.find(x => x.id === user.id);
        if (!existing) {
          accounts.list.push({ id: user.id, name, email: user.email || '', role: 'user', active: true, isCloud: true, createdAt: new Date().toISOString() });
          accounts.save();
        } else {
          // Update name/email in case they changed
          existing.name = name;
          existing.email = user.email || existing.email;
          existing.isCloud = true;
          accounts.save();
        }
      }

      this.renderDrawerAccountCloud(name, role);

      this.setPeriod(this.selectedPeriod, false);
      this.navigateToTab(role === 'admin' ? 'admin-dashboard' : 'dashboard');
      this.hideSplash();
    };

    if (typeof FinovaCloud !== 'undefined' && FinovaCloud.user) {
      FinovaCloud.loadState()
        .then(s => setTimeout(() => finish(s), 1400))
        .catch(() => setTimeout(() => finish({}), 1400));
    } else {
      setTimeout(() => finish({}), 1400);
    }
  }

  renderDrawerAccountCloud(name, role) {
    const av = document.getElementById('drawerAvatar');
    if (av) { av.textContent = name.charAt(0).toUpperCase(); av.style.background = avatarColor(name); }
    const dn = document.getElementById('drawerName');
    if (dn) dn.textContent = name;
    const rb = document.getElementById('drawerRole');
    if (rb) { rb.textContent = role === 'admin' ? 'Admin' : 'User'; rb.className = 'role-badge ' + role; }
  }

  renderDrawerAccount() {
    const acc = accounts.get();
    if (!acc) return;
    const av = document.getElementById('drawerAvatar');
    av.textContent = acc.name.charAt(0).toUpperCase();
    av.style.background = avatarColor(acc.name);
    document.getElementById('drawerName').textContent = acc.name;
    const rb = document.getElementById('drawerRole');
    rb.textContent = acc.role === 'admin' ? 'Admin' : 'User';
    rb.className = 'role-badge ' + acc.role;
  }

  // Header shows total income on every page except the dashboard
  updateTopbarIncome() {
    const el = document.getElementById('topbarIncomeValue');
    if (!el) return;
    const income = this.filterByPeriod(store.state.transactions)
      .filter(t => t.type === 'income')
      .reduce((sum, t) => sum + t.amount, 0);
    el.textContent = formatCurrency(income);
  }

  showViewLoader(viewId, ms) {
    const view = document.getElementById(viewId);
    if (!view) return;
    view.classList.add('is-loading');
    clearTimeout(this['_loader_' + viewId]);
    this['_loader_' + viewId] = setTimeout(() => view.classList.remove('is-loading'), ms);
  }

  applyPrefsUI() {
    const cur = document.getElementById('settingCurrency');
    if (cur && !cur.options.length) {
      cur.innerHTML = Object.entries(CURRENCIES).map(([c, n]) => `<option value="${c}">${c} — ${n}</option>`).join('');
    }
    if (cur) cur.value = prefs.currency;
    document.querySelectorAll('#settingLanguage,#authLangSelect').forEach(s => {
      if (!s.options.length) s.innerHTML = Object.entries(LANG_META).map(([c, m]) => `<option value="${c}">${m.label}</option>`).join('');
      s.value = prefs.lang;
    });
    const lang = null;
    if (lang) lang.value = prefs.lang;

    const sym = currencySymbol();
    document.querySelectorAll('[data-cur-label]').forEach(l => {
      if (l.dataset.pre === undefined) {
        const m = l.textContent.match(/^(.*?) \(\$\)(.*)$/);
        if (!m) return;
        l.dataset.pre = m[1];
        l.dataset.post = m[2];
      }
      l.textContent = `${l.dataset.pre} (${sym})${l.dataset.post}`;
    });
  }

  setLanguage(lang) {
    prefs.lang = lang;
    savePrefs();
    document.documentElement.lang = lang;
    document.querySelectorAll('#settingLanguage,#authLangSelect').forEach(s => { s.value = lang; });
    this.renderAll();
    i18nApply();
    showToast('Language updated', 'success');
  }

  setCurrency(code) {
    prefs.currency = code;
    savePrefs();
    this.applyPrefsUI();
    this.renderAll();
    showToast('Currency updated', 'success');
  }

  i18nObserve() {
    document.documentElement.lang = prefs.lang;
    let pending = false;
    new MutationObserver(() => {
      if (prefs.lang === 'en' || pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; i18nApply(); });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    if (prefs.lang !== 'en') i18nApply();
  }

  navigateToTab(tabName) {
    if ((tabName === 'documents' || tabName.startsWith('admin-')) && accounts.role() !== 'admin') {
      tabName = 'dashboard';
    }
    if (tabName !== 'settings' && tabName !== 'documents' && !tabName.startsWith('admin-') && accounts.role() === 'admin') {
      tabName = 'admin-dashboard';
    }
    this.activeTab = tabName;
    document.body.classList.toggle('on-dashboard', tabName === 'dashboard' || tabName === 'admin-dashboard');
    document.body.classList.toggle('on-settings', tabName === 'settings');
    document.body.setAttribute('data-tab', tabName);
    if (tabName === 'transactions') this.showViewLoader('view-transactions', 700);
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.mobile-nav-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.page-view').forEach(view => {
      view.classList.toggle('active', view.id === `view-${tabName}`);
    });

    // Update Topbar Title & Subtitle
    const titleMap = {
      dashboard: ['Dashboard', 'Personal financial overview'],
      transactions: ['Transactions', 'All recorded expenses and income'],
      recurring: ['Recurring Payments', 'Active subscriptions and bills detection'],
      subscriptions: ['Subscriptions', 'Track your recurring service renewals'],
      budgets: ['Budgets', 'Monthly spend limits and category caps'],
      goals: ['Savings Goals', 'Progress towards financial milestones'],
      documents: ['Documents Vault', 'Receipts, statements, and Drive sync'],
      settings: ['Settings', 'Net worth, categories, accounts, and system']
    };

    const adminTitles = { 'admin-dashboard': ['Admin Dashboard', 'Users, budgets and activity overview'], 'admin-users': ['User Management', 'Registered accounts and access'], 'admin-budgets': ['Budget Management', 'User income, budget status and summaries'], 'admin-transactions': ['All Transactions', 'Receipts and spending by category'] };
    const [title, sub] = titleMap[tabName] || adminTitles[tabName] || ['Finova', ''];
    document.getElementById('pageTitle').textContent = title;
    document.getElementById('pageSubtitle').textContent = sub;

    // Render Tab Content
    this.renderActiveTab();
    this.refreshIcons();
  }

  setPeriod(period, save = true) {
    this.selectedPeriod = period;
    if (save) {
      store.state.selectedPeriod = period;
      store.saveState();
    }

    // Sync button UI
    document.querySelectorAll('#dashboardPeriodSelector .period-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-period') === period);
    });

    const txSelect = document.getElementById('txPeriodFilter');
    if (txSelect && txSelect.value !== period) {
      txSelect.value = period;
    }

    this.renderAll();
  }

  filterByPeriod(records) {
    if (this.selectedPeriod === 'all-time') return records;

    const now = new Date();
    const currYear = now.getFullYear();
    const currMonth = now.getMonth(); // 0-indexed

    return records.filter(item => {
      const d = new Date(item.date + 'T00:00:00');
      if (isNaN(d.getTime())) return false;

      const y = d.getFullYear();
      const m = d.getMonth();

      switch (this.selectedPeriod) {
        case 'this-month':
          return y === currYear && m === currMonth;
        case 'this-week': {
          // Week starts on Monday
          const weekStart = new Date(currYear, currMonth, now.getDate() - ((now.getDay() + 6) % 7));
          return d >= weekStart;
        }
        case 'this-year':
          return y === currYear;
        default:
          return true;
      }
    });
  }

  // ===========================================================================
  // Render Hub
  // ===========================================================================
  renderAll() {
    this.renderDashboard();
    this.renderTransactions();
    this.renderRecurring();
    this.renderSubscriptions();
    this.renderBudgets();
    this.renderGoals();
    this.renderDocuments();
    this.renderSettings();
    this.populateDropdowns();
    this.updateTopbarIncome();
    if (this.activeTab && this.activeTab.startsWith('admin-')) this.renderAdmin(this.activeTab);
    this.refreshIcons();
  }

  renderActiveTab() {
    switch (this.activeTab) {
      case 'dashboard': this.renderDashboard(); break;
      case 'transactions': this.renderTransactions(); break;
      case 'recurring': this.renderRecurring(); break;
      case 'subscriptions': this.renderSubscriptions(); break;
      case 'budgets': this.renderBudgets(); break;
      case 'goals': this.renderGoals(); break;
      case 'documents': this.renderDocuments(); break;
      case 'settings': this.renderSettings(); break;
      case 'admin-dashboard': case 'admin-users': case 'admin-budgets': case 'admin-transactions': this.renderAdmin(this.activeTab); break;
    }
  }

  // ===========================================================================
  // Page 1: Dashboard Rendering
  // ===========================================================================
  renderLiveMarketUI() {
    const track = document.getElementById('liveTickerTrack');
    if (!track) return;

    const pairs = [
      { from: 'USD', to: 'PHP', symbol: '₱', decimals: 2 },
      { from: 'EUR', to: 'USD', symbol: '$', decimals: 4, invert: true },
      { from: 'GBP', to: 'USD', symbol: '$', decimals: 4, invert: true },
      { from: 'USD', to: 'JPY', symbol: '¥', decimals: 2 },
      { from: 'USD', to: 'SGD', symbol: 'S$', decimals: 3 },
      { from: 'USD', to: 'CAD', symbol: 'C$', decimals: 3 },
      { from: 'USD', to: 'AUD', symbol: 'A$', decimals: 3 },
      { from: 'USD', to: 'KRW', symbol: '₩', decimals: 1 }
    ];

    track.innerHTML = pairs.map(p => {
      let rate;
      if (p.invert) {
        const baseRate = liveRatesService.getRate(p.from);
        rate = baseRate ? (1 / baseRate) : 1;
      } else {
        rate = liveRatesService.getRate(p.to);
      }
      return `
        <div class="ticker-pill" title="1 ${p.from} = ${p.symbol}${rate.toFixed(p.decimals)} ${p.to}">
          <span class="ticker-pair">${p.from}/${p.to}</span>
          <strong class="ticker-rate">${p.symbol}${rate.toFixed(p.decimals)}</strong>
          <span class="ticker-badge"><i data-lucide="trending-up"></i> Live</span>
        </div>
      `;
    }).join('');

    const badge = document.getElementById('liveMarketBadge');
    if (badge) {
      if (liveRatesService.status === 'live') {
        badge.className = 'badge badge-green';
        badge.textContent = 'Live API';
      } else if (liveRatesService.status === 'fetching') {
        badge.className = 'badge badge-purple';
        badge.textContent = 'Syncing...';
      } else {
        badge.className = 'badge badge-subtle';
        badge.textContent = 'Cached';
      }
    }

    const timeEl = document.getElementById('liveMarketTime');
    if (timeEl) {
      if (liveRatesService.lastUpdated) {
        const timeStr = liveRatesService.lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        timeEl.textContent = `Live: ${timeStr}`;
      } else {
        timeEl.textContent = 'Auto-refresh: 60s';
      }
    }

    const activeCurr = prefs.currency || 'USD';
    const activeRate = liveRatesService.getRate(activeCurr);
    const prevEl = document.getElementById('settingsActiveRatePreview');
    if (prevEl) {
      prevEl.textContent = `1 USD = ${activeRate.toFixed(2)} ${activeCurr}`;
    }

    const settUpdated = document.getElementById('settingsRatesUpdated');
    if (settUpdated && liveRatesService.lastUpdated) {
      settUpdated.textContent = `Synced: ${liveRatesService.lastUpdated.toLocaleTimeString()}`;
    }

    const settBadge = document.getElementById('settingsApiStatus');
    if (settBadge) {
      settBadge.textContent = liveRatesService.status === 'live' ? 'Active • open.er-api.com' : 'Cached • Local Storage';
    }

    this.refreshIcons();
  }

  renderDashboard() {
    this.renderLiveMarketUI();
    const periodTransactions = this.filterByPeriod(store.state.transactions);

    // 1. Net Worth Card (Section 6.2)
    const kpiNetWorth = document.getElementById('kpiNetWorth');
    const kpiNetWorthDesc = document.getElementById('kpiNetWorthDesc');
    const cardNetWorth = document.getElementById('cardNetWorth');

    if (!store.state.netWorthConfigured) {
      kpiNetWorth.textContent = 'Not set';
      kpiNetWorth.className = 'metric-value text-muted';
      kpiNetWorthDesc.textContent = 'Assets minus liabilities';
      cardNetWorth.classList.remove('configured');
    } else {
      const net = (store.state.assetsTotal || 0) - (store.state.liabilitiesTotal || 0);
      kpiNetWorth.textContent = formatCurrency(net);
      kpiNetWorth.className = `metric-value ${net >= 0 ? 'text-green' : 'text-danger'}`;
      kpiNetWorthDesc.textContent = `Assets: ${formatCurrency(store.state.assetsTotal)} | Liab: ${formatCurrency(store.state.liabilitiesTotal)}`;
      cardNetWorth.classList.add('configured');
    }

    // 2. Income & Spending Sums
    let totalIncome = 0;
    let incomeCount = 0;
    let totalSpending = 0;
    let spendingCount = 0;

    periodTransactions.forEach(tx => {
      if (tx.type === 'income') {
        totalIncome += tx.amount;
        incomeCount++;
      } else {
        totalSpending += tx.amount;
        spendingCount++;
      }
    });

    document.getElementById('kpiIncome').textContent = formatCurrency(totalIncome);
    document.getElementById('kpiIncomeCount').textContent = `${incomeCount} income transaction${incomeCount === 1 ? '' : 's'}`;

    document.getElementById('kpiSpending').textContent = formatCurrency(totalSpending);
    document.getElementById('kpiSpendingCount').textContent = `${spendingCount} expense transaction${spendingCount === 1 ? '' : 's'}`;

    // 3. Savings Rate: ((income - spending) / income) * 100
    const savingsNet = totalIncome - totalSpending;
    let savingsRate = 0;
    if (totalIncome > 0) {
      savingsRate = Math.max(-100, Math.min(100, ((totalIncome - totalSpending) / totalIncome) * 100));
    }

    document.getElementById('kpiSavingsRate').textContent = `${savingsRate.toFixed(1)}%`;
    document.getElementById('kpiSavingsNet').textContent = `Net: ${formatCurrency(savingsNet)} saved`;

    // 4. Render Cash Flow Chart & Donut Chart
    this.renderCashFlowChart(periodTransactions);
    this.renderCategoryDonut(periodTransactions);

    // 5. Recent Activity (5 latest transactions in period)
    const recentList = document.getElementById('dashboardRecentList');
    recentList.innerHTML = '';

    if (periodTransactions.length === 0) {
      recentList.innerHTML = `
        <div class="empty-state-card" style="padding: 1.5rem 1rem;">
          <i data-lucide="inbox"></i>
          <p>No activity in this period. Add an entry or import a CSV statement.</p>
        </div>
      `;
    } else {
      const top5 = periodTransactions.slice(0, 5);
      top5.forEach(tx => {
        const isIncome = tx.type === 'income';
        const item = document.createElement('div');
        item.className = 'recent-row';
        item.innerHTML = `
          <div class="recent-left">
            <div class="recent-icon-wrap">
              <i data-lucide="${isIncome ? 'arrow-down-left' : 'arrow-up-right'}" class="${isIncome ? 'text-green' : 'text-orange'}"></i>
            </div>
            <div class="recent-info">
              <span class="recent-merchant">${escapeHTML(tx.merchant)}</span>
              <span class="recent-subline">
                <span>${tx.date}</span> &bull; 
                <span class="badge badge-neutral" style="font-size: 0.68rem; padding: 0.1rem 0.4rem;">${escapeHTML(tx.category)}</span>
              </span>
            </div>
          </div>
          <div class="recent-amount ${isIncome ? 'text-green' : ''}">
            ${isIncome ? '+' : '-'}${formatCurrency(tx.amount)}
          </div>
        `;
        recentList.appendChild(item);
      });
    }

    // 6. Insights & Coming Up
    const needsReviewCount = periodTransactions.filter(t => t.category === 'Needs review').length;
    const insightsEl = document.getElementById('dashboardInsights');
    insightsEl.innerHTML = `
      <div class="insight-item">
        <i data-lucide="${needsReviewCount > 0 ? 'alert-circle' : 'check-circle'}" class="${needsReviewCount > 0 ? 'text-orange' : 'text-green'}"></i>
        <div>
          <strong>${needsReviewCount > 0 ? `${needsReviewCount} Items Need Review` : 'All Categories Assigned'}</strong>
          <p>${needsReviewCount > 0 ? 'Some transactions are categorized as "Needs review". Update them in Transactions.' : 'All transactions in this period have assigned categories.'}</p>
        </div>
      </div>
    `;

    // Coming Up (Confirmed recurring or subscriptions due soon)
    const comingUpList = document.getElementById('dashboardComingUpList');
    comingUpList.innerHTML = '';
    const allUpcoming = [
      ...store.state.recurring.map(r => ({ ...r, kind: 'Bill' })),
      ...store.state.subscriptions.map(s => ({ ...s, kind: 'Sub' }))
    ].sort((a, b) => new Date(a.nextDate || '2099-01-01') - new Date(b.nextDate || '2099-01-01'));

    if (allUpcoming.length === 0) {
      comingUpList.innerHTML = `
        <div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 1rem 0;">
          No recurring payments scheduled. Link to <a href="#" onclick="app.navigateToTab('recurring'); return false;" class="text-purple">Recurring</a>.
        </div>
      `;
    } else {
      allUpcoming.slice(0, 3).forEach(item => {
        const div = document.createElement('div');
        div.className = 'coming-item';
        div.innerHTML = `
          <div class="coming-item-left">
            <span class="coming-name">${escapeHTML(item.name)}</span>
            <span class="coming-date">Due: ${item.nextDate || 'Upcoming'} (${item.cadence})</span>
          </div>
          <span class="coming-amount text-orange">-${formatCurrency(item.amount)}</span>
        `;
        comingUpList.appendChild(div);
      });
    }
  }

  // Cash Flow Chart Rendering
  renderCashFlowChart(transactions) {
    const canvas = document.getElementById('cashFlowCanvas');
    const emptyState = document.getElementById('cashFlowEmpty');
    if (!canvas) return;

    if (transactions.length === 0) {
      canvas.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
      if (this.cashFlowChart) {
        this.cashFlowChart.destroy();
        this.cashFlowChart = null;
      }
      return;
    }

    canvas.style.display = 'block';
    if (emptyState) emptyState.style.display = 'none';

    // Group transactions by Month (up to 7 months)
    const monthMap = {};
    transactions.forEach(t => {
      const ym = t.date.substring(0, 7); // YYYY-MM
      if (!monthMap[ym]) {
        monthMap[ym] = { income: 0, expense: 0 };
      }
      if (t.type === 'income') {
        monthMap[ym].income += t.amount;
      } else {
        monthMap[ym].expense += t.amount;
      }
    });

    const sortedMonths = Object.keys(monthMap).sort().slice(-7);
    const labels = sortedMonths.map(ym => {
      const [y, m] = ym.split('-');
      const d = new Date(y, m - 1);
      return d.toLocaleDateString((LANG_META[prefs.lang] || LANG_META.en).locale, { month: 'short', year: '2-digit' });
    });

    const incomeData = sortedMonths.map(m => monthMap[m].income);
    const expenseData = sortedMonths.map(m => monthMap[m].expense);

    if (this.cashFlowChart) {
      this.cashFlowChart.destroy();
    }

    if (window.Chart) {
      this.cashFlowChart = new window.Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Income',
              data: incomeData,
              backgroundColor: '#0a8159',
              borderRadius: 6
            },
            {
              label: 'Spending',
              data: expenseData,
              backgroundColor: '#cf4a1a',
              borderRadius: 6
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: (val) => currencySymbol() + val
              },
              grid: { color: '#eef0f7' }
            },
            x: {
              grid: { display: false }
            }
          }
        }
      });
    }
  }

  // Spending by Category Donut Chart Rendering
  renderCategoryDonut(transactions) {
    const canvas = document.getElementById('categoryDonutCanvas');
    const emptyState = document.getElementById('donutEmpty');
    const legendList = document.getElementById('donutLegendList');
    if (!canvas || !legendList) return;

    const expenses = transactions.filter(t => t.type === 'expense');

    if (expenses.length === 0) {
      canvas.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
      legendList.innerHTML = '';
      if (this.donutChart) {
        this.donutChart.destroy();
        this.donutChart = null;
      }
      return;
    }

    canvas.style.display = 'block';
    if (emptyState) emptyState.style.display = 'none';

    // Group by category
    const catMap = {};
    let totalExpense = 0;
    expenses.forEach(t => {
      catMap[t.category] = (catMap[t.category] || 0) + t.amount;
      totalExpense += t.amount;
    });

    const sortedCats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
    const labels = sortedCats.map(c => c[0]);
    const values = sortedCats.map(c => c[1]);

    const palette = [
      '#4338ca', '#f5a524', '#0a8159', '#cf4a1a', '#2f80ed',
      '#8b5cf6', '#14b8d4', '#e0457b', '#64748b', '#a5b4fc'
    ];

    const bgColors = labels.map((_, i) => palette[i % palette.length]);

    // Legend List
    legendList.innerHTML = sortedCats.map(([cat, amt], i) => {
      const pct = totalExpense > 0 ? ((amt / totalExpense) * 100).toFixed(0) : 0;
      return `
        <div class="donut-legend-row">
          <div class="legend-color-label">
            <span class="dot" style="background-color: ${palette[i % palette.length]}"></span>
            <span>${escapeHTML(cat)}</span>
          </div>
          <span class="legend-percent">${formatCurrency(amt)} (${pct}%)</span>
        </div>
      `;
    }).join('');

    if (this.donutChart) {
      this.donutChart.destroy();
    }

    if (window.Chart) {
      this.donutChart = new window.Chart(canvas, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{
            data: values,
            backgroundColor: bgColors,
            borderWidth: 2,
            borderColor: '#ffffff'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: {
            legend: { display: false }
          }
        }
      });
    }
  }

  // ===========================================================================
  // Page 2: Transactions Rendering & Inline Editing (Section 7)
  // ===========================================================================
  renderTransactions() {
    const tableBody = document.getElementById('transactionsTableBody');
    const emptyState = document.getElementById('txEmptyState');
    if (!tableBody) return;

    let records = this.filterByPeriod(store.state.transactions);

    // Search filter
    const searchTerm = (document.getElementById('txSearchInput')?.value || '').toLowerCase().trim();
    if (searchTerm) {
      records = records.filter(tx => 
        tx.merchant.toLowerCase().includes(searchTerm) ||
        tx.category.toLowerCase().includes(searchTerm)
      );
    }

    // Category filter
    const catFilter = document.getElementById('txCategoryFilter')?.value;
    if (catFilter) {
      records = records.filter(tx => tx.category === catFilter);
    }

    // Account filter
    const accFilter = document.getElementById('txAccountFilter')?.value;
    if (accFilter) {
      records = records.filter(tx => tx.account === accFilter);
    }

    // Update Counts & Sums
    const badge = document.getElementById('txCountBadge');
    if (badge) badge.textContent = `${records.length} transaction${records.length === 1 ? '' : 's'}`;

    const netSum = records.reduce((acc, tx) => acc + (tx.type === 'income' ? tx.amount : -tx.amount), 0);
    const netSumEl = document.getElementById('txNetSum');
    if (netSumEl) netSumEl.textContent = `Net: ${formatCurrency(netSum)}`;

    tableBody.innerHTML = '';

    if (records.length === 0) {
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    records.forEach(tx => {
      const tr = document.createElement('tr');
      const isIncome = tx.type === 'income';

      // Inline Category Options
      const catOptions = store.state.categories.map(c => 
        `<option value="${escapeHTML(c)}" ${c === tx.category ? 'selected' : ''}>${escapeHTML(c)}</option>`
      ).join('');

      tr.innerHTML = `
        <td>
          <div class="tx-merchant-col">
            <span class="tx-merchant">${escapeHTML(tx.merchant)}</span>
            <span class="tx-date">${tx.date}</span>
          </div>
        </td>
        <td>
          <select class="inline-category-select" data-tx-id="${tx.id}">
            ${catOptions}
          </select>
        </td>
        <td><span class="text-muted" style="font-size: 0.8rem;">${escapeHTML(tx.account)}</span></td>
        <td>
          ${tx.receipt ? `<span class="receipt-icon-badge" title="Receipt attached"><i data-lucide="receipt"></i></span>` : `<span class="text-muted" style="font-size:0.75rem;">—</span>`}
        </td>
        <td class="text-right tx-amount ${isIncome ? 'text-green' : ''}">
          ${isIncome ? '+' : '-'}${formatCurrency(tx.amount)}
        </td>
        <td class="text-center">
          <div class="table-action-btns">
            <button class="btn-icon-sm" data-edit-tx="${tx.id}" title="Edit"><i data-lucide="edit-3"></i></button>
            <button class="btn-icon-sm delete" data-delete-tx="${tx.id}" title="Delete"><i data-lucide="trash-2"></i></button>
          </div>
        </td>
      `;

      // Inline Category Edit Event (Section 7.1)
      const select = tr.querySelector('.inline-category-select');
      select.addEventListener('change', (e) => {
        store.updateTransaction(tx.id, { category: e.target.value });
        showToast(`Category updated to "${e.target.value}"`, 'success');
        this.renderAll();
      });

      // Delete Button Event
      tr.querySelector('[data-delete-tx]').addEventListener('click', () => {
        if (confirm(`Delete transaction for "${tx.merchant}"?`)) {
          store.deleteTransaction(tx.id);
          showToast('Transaction deleted', 'info');
          this.renderAll();
        }
      });

      // Edit Modal Event
      tr.querySelector('[data-edit-tx]').addEventListener('click', () => {
        this.openAddEntryModal(tx);
      });

      tableBody.appendChild(tr);
    });

    this.refreshIcons();
  }

  // ===========================================================================
  // Page 3: Recurring Payments & Detection Engine (Section 9 & 10)
  // ===========================================================================
  detectRecurringPatterns() {
    const expenses = store.state.transactions.filter(t => t.type === 'expense');
    
    // Group by normalized merchant
    const groups = {};
    expenses.forEach(t => {
      // 9.1 Merchant normalization
      const norm = t.merchant.toLowerCase()
        .replace(/#[0-9]+/g, '')
        .replace(/[0-9]{4,}/g, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!groups[norm]) groups[norm] = [];
      groups[norm].push(t);
    });

    const suggestions = [];

    Object.entries(groups).forEach(([norm, txList]) => {
      // Require at least 2 unique transaction dates
      const uniqueDates = Array.from(new Set(txList.map(t => t.date))).sort();
      if (uniqueDates.length < 2) return;

      // Calculate intervals between consecutive dates
      const intervals = [];
      for (let i = 1; i < uniqueDates.length; i++) {
        const d1 = new Date(uniqueDates[i - 1]);
        const d2 = new Date(uniqueDates[i]);
        const diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
        intervals.push(diffDays);
      }

      if (intervals.length === 0) return;

      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

      // Cadence Classification (9.2)
      let cadence = null;
      if (avgInterval >= 5 && avgInterval <= 9) cadence = 'weekly';
      else if (avgInterval >= 12 && avgInterval <= 17) cadence = 'biweekly';
      else if (avgInterval >= 24 && avgInterval <= 40) cadence = 'monthly';
      else if (avgInterval >= 75 && avgInterval <= 110) cadence = 'quarterly';
      else if (avgInterval >= 330 && avgInterval <= 400) cadence = 'annual';

      if (!cadence) return;

      // Amounts and variation check
      const amounts = txList.map(t => t.amount);
      const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const maxVar = Math.max(...amounts.map(a => Math.abs(a - avgAmount) / avgAmount));

      // Check hint matches (9.3 & 9.4)
      const isSubHint = SUBSCRIPTION_HINTS.some(h => norm.includes(h)) || txList.some(t => (t.category || '').toLowerCase().includes('subscription'));
      const isBillHint = RECURRING_HINTS.some(h => norm.includes(h));

      let allowedVariance = 0.35;
      if (isSubHint) allowedVariance = 0.20;

      // 9.5 Protection against false positives
      if (!isSubHint && !isBillHint) {
        if (uniqueDates.length < 3 || maxVar > 0.03 || ['weekly', 'biweekly'].includes(cadence)) {
          return;
        }
      }

      if (maxVar > allowedVariance) return;

      // Check if already confirmed or dismissed
      const isDismissed = (store.state.dismissedPatterns || []).includes(norm);
      if (isDismissed) return;

      const isAlreadyConfirmed = store.state.recurring.some(r => r.name.toLowerCase() === norm) ||
        store.state.subscriptions.some(s => s.name.toLowerCase() === norm);
      if (isAlreadyConfirmed) return;

      // Confidence determination (9.6)
      const isHighConfidence = uniqueDates.length >= 3 && maxVar <= 0.12;

      // Calculate monthly equivalent (9.6)
      let monthlyEquiv = avgAmount;
      if (cadence === 'weekly') monthlyEquiv = (avgAmount * 52) / 12;
      else if (cadence === 'biweekly') monthlyEquiv = (avgAmount * 26) / 12;
      else if (cadence === 'quarterly') monthlyEquiv = avgAmount / 3;
      else if (cadence === 'annual') monthlyEquiv = avgAmount / 12;

      // Project next date calendar-aware
      const lastDate = new Date(uniqueDates[uniqueDates.length - 1]);
      const nextDate = new Date(lastDate);
      if (cadence === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
      else if (cadence === 'biweekly') nextDate.setDate(nextDate.getDate() + 14);
      else if (cadence === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
      else if (cadence === 'quarterly') nextDate.setMonth(nextDate.getMonth() + 3);
      else if (cadence === 'annual') nextDate.setFullYear(nextDate.getFullYear() + 1);

      suggestions.push({
        normalizedName: norm,
        displayName: txList[0].merchant,
        category: txList[0].category || 'Other',
        account: txList[0].account || 'Main Checking',
        cadence,
        occurrenceCount: uniqueDates.length,
        avgAmount,
        monthlyEquiv,
        confidence: isHighConfidence ? 'High confidence' : 'Likely',
        nextDate: nextDate.toISOString().split('T')[0],
        isSubscription: isSubHint
      });
    });

    return suggestions;
  }

  renderRecurring() {
    const suggestions = this.detectRecurringPatterns().filter(s => !s.isSubscription);
    const suggList = document.getElementById('recurringSuggestionsList');
    const suggCount = document.getElementById('recurringSuggestionsCount');

    if (suggCount) suggCount.textContent = `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}`;

    if (suggList) {
      suggList.innerHTML = '';
      if (suggestions.length === 0) {
        suggList.innerHTML = `<p class="text-muted" style="font-size: 0.85rem; padding: 0.5rem 0;">No new recurring patterns detected from transaction history.</p>`;
      } else {
        suggestions.forEach(s => {
          const card = document.createElement('div');
          card.className = 'suggestion-card';
          card.innerHTML = `
            <div class="sugg-meta-left">
              <div class="sugg-title-row">
                <span class="sugg-name">${escapeHTML(s.displayName)}</span>
                <span class="badge ${s.confidence === 'High confidence' ? 'badge-green' : 'badge-purple'}">${s.confidence}</span>
              </div>
              <div class="sugg-details-row">
                <span>Cadence: <strong>${s.cadence}</strong></span> &bull;
                <span>Observed: ${s.occurrenceCount} times</span> &bull;
                <span>Next estimated: ${s.nextDate}</span>
              </div>
            </div>
            <div class="sugg-actions-right">
              <div class="sugg-amounts">
                <span class="sugg-avg-amount">${formatCurrency(s.avgAmount)}</span>
                <div class="sugg-monthly-equiv">~${formatCurrency(s.monthlyEquiv)}/mo</div>
              </div>
              <div class="sugg-btn-group">
                <button class="btn btn-secondary btn-sm" data-ignore-pattern="${escapeHTML(s.normalizedName)}">Ignore</button>
                <button class="btn btn-primary btn-sm" data-keep-recurring='${JSON.stringify(s)}'>Keep</button>
              </div>
            </div>
          `;

          card.querySelector('[data-ignore-pattern]').addEventListener('click', (e) => {
            const key = e.target.getAttribute('data-ignore-pattern');
            store.state.dismissedPatterns.push(key);
            store.saveState();
            showToast('Pattern ignored', 'info');
            this.renderRecurring();
            this.renderSubscriptions();
          });

          card.querySelector('[data-keep-recurring]').addEventListener('click', () => {
            store.state.recurring.push({
              id: 'rec_' + Date.now(),
              name: s.displayName,
              category: s.category,
              amount: s.avgAmount,
              cadence: s.cadence,
              nextDate: s.nextDate,
              account: s.account,
              active: true
            });
            store.saveState();
            showToast(`Confirmed recurring payment for "${s.displayName}"`, 'success');
            this.renderRecurring();
          });

          suggList.appendChild(card);
        });
      }
    }

    // Totals Commitment Bar
    let monthlyTotal = 0;
    store.state.recurring.filter(r => r.active).forEach(r => {
      let m = r.amount;
      if (r.cadence === 'weekly') m = (r.amount * 52) / 12;
      else if (r.cadence === 'biweekly') m = (r.amount * 26) / 12;
      else if (r.cadence === 'quarterly') m = r.amount / 3;
      else if (r.cadence === 'annual') m = r.amount / 12;
      monthlyTotal += m;
    });

    document.getElementById('recurringMonthlyTotal').textContent = formatCurrency(monthlyTotal);
    document.getElementById('recurringAnnualTotal').textContent = formatCurrency(monthlyTotal * 12);

    // Next Expected Payment
    const sortedDue = [...store.state.recurring].sort((a, b) => new Date(a.nextDate) - new Date(b.nextDate));
    if (sortedDue.length > 0) {
      document.getElementById('recurringNextDue').textContent = sortedDue[0].nextDate;
      document.getElementById('recurringNextDueDesc').textContent = `${sortedDue[0].name} (${formatCurrency(sortedDue[0].amount)})`;
    } else {
      document.getElementById('recurringNextDue').textContent = 'None scheduled';
      document.getElementById('recurringNextDueDesc').textContent = 'Add recurring payment to track';
    }

    // Confirmed Table
    const tableBody = document.getElementById('recurringTableBody');
    const emptyState = document.getElementById('recurringEmptyState');
    if (tableBody) {
      tableBody.innerHTML = '';
      if (store.state.recurring.length === 0) {
        if (emptyState) emptyState.style.display = 'flex';
      } else {
        if (emptyState) emptyState.style.display = 'none';
        store.state.recurring.forEach(item => {
          let m = item.amount;
          if (item.cadence === 'weekly') m = (item.amount * 52) / 12;
          else if (item.cadence === 'biweekly') m = (item.amount * 26) / 12;
          else if (item.cadence === 'quarterly') m = item.amount / 3;
          else if (item.cadence === 'annual') m = item.amount / 12;

          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>${escapeHTML(item.name)}</strong></td>
            <td><span class="badge badge-neutral">${escapeHTML(item.category || 'Other')}</span></td>
            <td>${item.cadence}</td>
            <td>${item.nextDate}</td>
            <td>${escapeHTML(item.account || '—')}</td>
            <td class="font-mono text-muted">~${formatCurrency(m)}</td>
            <td class="font-mono text-orange">-${formatCurrency(item.amount)}</td>
            <td><span class="badge ${item.active ? 'badge-green' : 'badge-neutral'}">${item.active ? 'Active' : 'Paused'}</span></td>
            <td class="text-center">
              <div class="table-action-btns">
                <button class="btn-icon-sm" data-edit-rec="${item.id}"><i data-lucide="edit-3"></i></button>
                <button class="btn-icon-sm delete" data-delete-rec="${item.id}"><i data-lucide="trash-2"></i></button>
              </div>
            </td>
          `;

          tr.querySelector('[data-delete-rec]').addEventListener('click', () => {
            store.state.recurring = store.state.recurring.filter(r => r.id !== item.id);
            store.saveState();
            showToast('Recurring item deleted', 'info');
            this.renderRecurring();
          });

          tr.querySelector('[data-edit-rec]').addEventListener('click', () => {
            this.openAddRecurringModal(item);
          });

          tableBody.appendChild(tr);
        });
      }
    }
  }

  // ===========================================================================
  // Page 4: Subscriptions Page (Section 11)
  // ===========================================================================
  renderSubscriptions() {
    const candidates = this.detectRecurringPatterns().filter(s => s.isSubscription);
    const candList = document.getElementById('subSuggestionsList');
    const candCount = document.getElementById('subSuggestionsCount');

    if (candCount) candCount.textContent = `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`;

    if (candList) {
      candList.innerHTML = '';
      if (candidates.length === 0) {
        candList.innerHTML = `<p class="text-muted" style="font-size: 0.85rem; padding: 0.5rem 0;">No subscription hints detected yet from transactions.</p>`;
      } else {
        candidates.forEach(s => {
          const card = document.createElement('div');
          card.className = 'suggestion-card';
          card.innerHTML = `
            <div class="sugg-meta-left">
              <div class="sugg-title-row">
                <span class="sugg-name">${escapeHTML(s.displayName)}</span>
                <span class="badge badge-purple">${s.confidence}</span>
              </div>
              <div class="sugg-details-row">
                <span>Cycle: <strong>${s.cadence}</strong></span> &bull;
                <span>Occurrences: ${s.occurrenceCount}</span>
              </div>
            </div>
            <div class="sugg-actions-right">
              <div class="sugg-amounts">
                <span class="sugg-avg-amount">${formatCurrency(s.avgAmount)}</span>
                <div class="sugg-monthly-equiv">~${formatCurrency(s.monthlyEquiv)}/mo</div>
              </div>
              <div class="sugg-btn-group">
                <button class="btn btn-secondary btn-sm" data-ignore-sub="${escapeHTML(s.normalizedName)}">Ignore</button>
                <button class="btn btn-primary btn-sm" data-keep-sub='${JSON.stringify(s)}'>Confirm</button>
              </div>
            </div>
          `;

          card.querySelector('[data-ignore-sub]').addEventListener('click', (e) => {
            const key = e.target.getAttribute('data-ignore-sub');
            store.state.dismissedPatterns.push(key);
            store.saveState();
            showToast('Subscription suggestion dismissed', 'info');
            this.renderSubscriptions();
          });

          card.querySelector('[data-keep-sub]').addEventListener('click', () => {
            store.state.subscriptions.push({
              id: 'sub_' + Date.now(),
              name: s.displayName,
              category: s.category || 'Subscriptions',
              amount: s.avgAmount,
              cadence: s.cadence,
              nextDate: s.nextDate,
              account: s.account,
              active: true
            });
            store.saveState();
            showToast(`Added "${s.displayName}" to active subscriptions`, 'success');
            this.renderSubscriptions();
          });

          candList.appendChild(card);
        });
      }
    }

    // Totals
    let subMonthly = 0;
    store.state.subscriptions.filter(s => s.active).forEach(s => {
      let m = s.amount;
      if (s.cadence === 'annual') m = s.amount / 12;
      else if (s.cadence === 'quarterly') m = s.amount / 3;
      else if (s.cadence === 'weekly') m = (s.amount * 52) / 12;
      subMonthly += m;
    });

    document.getElementById('subMonthlyTotal').textContent = formatCurrency(subMonthly);
    document.getElementById('subAnnualTotal').textContent = formatCurrency(subMonthly * 12);
    document.getElementById('subActiveCount').textContent = store.state.subscriptions.length;

    const nextRenew = [...store.state.subscriptions].sort((a, b) => new Date(a.nextDate) - new Date(b.nextDate))[0];
    if (nextRenew) {
      document.getElementById('subNextRenewal').textContent = nextRenew.nextDate;
      document.getElementById('subNextRenewalService').textContent = `${nextRenew.name} (${formatCurrency(nextRenew.amount)})`;
    } else {
      document.getElementById('subNextRenewal').textContent = 'None';
      document.getElementById('subNextRenewalService').textContent = 'No upcoming renewal';
    }

    // Table
    const tableBody = document.getElementById('subscriptionsTableBody');
    const emptyState = document.getElementById('subEmptyState');
    if (tableBody) {
      tableBody.innerHTML = '';
      if (store.state.subscriptions.length === 0) {
        if (emptyState) emptyState.style.display = 'flex';
      } else {
        if (emptyState) emptyState.style.display = 'none';
        store.state.subscriptions.forEach(sub => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>${escapeHTML(sub.name)}</strong></td>
            <td><span class="badge badge-purple">${escapeHTML(sub.category || 'Subscriptions')}</span></td>
            <td>${sub.cadence}</td>
            <td>${sub.nextDate}</td>
            <td>${escapeHTML(sub.account || '—')}</td>
            <td class="font-mono text-orange">-${formatCurrency(sub.amount)}</td>
            <td><span class="badge ${sub.active ? 'badge-green' : 'badge-neutral'}">${sub.active ? 'Active' : 'Paused'}</span></td>
            <td class="text-center">
              <div class="table-action-btns">
                <button class="btn-icon-sm" data-edit-sub="${sub.id}"><i data-lucide="edit-3"></i></button>
                <button class="btn-icon-sm delete" data-delete-sub="${sub.id}"><i data-lucide="trash-2"></i></button>
              </div>
            </td>
          `;

          tr.querySelector('[data-delete-sub]').addEventListener('click', () => {
            store.state.subscriptions = store.state.subscriptions.filter(s => s.id !== sub.id);
            store.saveState();
            showToast('Subscription removed', 'info');
            this.renderSubscriptions();
          });

          tr.querySelector('[data-edit-sub]').addEventListener('click', () => {
            this.openAddSubscriptionModal(sub);
          });

          tableBody.appendChild(tr);
        });
      }
    }
  }

  // ===========================================================================
  // Page 5: Budgets Page (Section 12)
  // ===========================================================================
  renderBudgets() {
    const grid = document.getElementById('budgetsGrid');
    const emptyState = document.getElementById('budgetsEmptyState');
    if (!grid) return;

    grid.innerHTML = '';

    if (store.state.budgets.length === 0) {
      if (emptyState) emptyState.style.display = 'flex';
      document.getElementById('budgetTotalLimit').textContent = '$0.00';
      document.getElementById('budgetTotalSpent').textContent = '$0.00';
      document.getElementById('budgetTotalRemaining').textContent = '$0.00';
      document.getElementById('budgetHealthPercent').textContent = '0%';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    // Calculate actual spending in current month
    const now = new Date();
    const currYear = now.getFullYear();
    const currMonth = now.getMonth();

    const currentMonthExpenses = store.state.transactions.filter(t => {
      if (t.type !== 'expense') return false;
      const d = new Date(t.date);
      return d.getFullYear() === currYear && d.getMonth() === currMonth;
    });

    const categorySpendMap = {};
    currentMonthExpenses.forEach(t => {
      categorySpendMap[t.category] = (categorySpendMap[t.category] || 0) + t.amount;
    });

    let overallLimit = 0;
    let overallSpent = 0;

    store.state.budgets.forEach(b => {
      const spent = categorySpendMap[b.category] || 0;
      const remaining = b.limit - spent;
      const pct = Math.min(100, Math.round((spent / b.limit) * 100));

      overallLimit += b.limit;
      overallSpent += spent;

      let fillClass = 'safe';
      if (pct >= 100) fillClass = 'danger';
      else if (pct >= 75) fillClass = 'warn';

      const card = document.createElement('div');
      card.className = 'budget-card';
      card.innerHTML = `
        <div class="budget-card-head">
          <span class="budget-cat-name">${escapeHTML(b.category)}</span>
          <div class="table-action-btns">
            <button class="btn-icon-sm" data-edit-bgt="${b.id}"><i data-lucide="edit-3"></i></button>
            <button class="btn-icon-sm delete" data-delete-bgt="${b.id}"><i data-lucide="trash-2"></i></button>
          </div>
        </div>
        <div class="budget-progress-track">
          <div class="budget-progress-fill ${fillClass}" style="width: ${pct}%"></div>
        </div>
        <div class="budget-numbers-row">
          <span class="budget-spent-lbl">${formatCurrency(spent)} <span class="text-muted" style="font-size:0.75rem;">/ ${formatCurrency(b.limit)}</span></span>
          <span class="budget-remain-lbl ${remaining < 0 ? 'text-danger font-weight-bold' : ''}">
            ${remaining < 0 ? `Over by ${formatCurrency(Math.abs(remaining))}` : `${formatCurrency(remaining)} left`}
          </span>
        </div>
      `;

      card.querySelector('[data-delete-bgt]').addEventListener('click', () => {
        store.state.budgets = store.state.budgets.filter(item => item.id !== b.id);
        store.saveState();
        showToast('Budget deleted', 'info');
        this.renderBudgets();
      });

      card.querySelector('[data-edit-bgt]').addEventListener('click', () => {
        this.openBudgetModal(b);
      });

      grid.appendChild(card);
    });

    const overallRemaining = overallLimit - overallSpent;
    const healthPercent = overallLimit > 0 ? Math.round((overallSpent / overallLimit) * 100) : 0;

    document.getElementById('budgetTotalLimit').textContent = formatCurrency(overallLimit);
    document.getElementById('budgetTotalSpent').textContent = formatCurrency(overallSpent);
    document.getElementById('budgetTotalRemaining').textContent = formatCurrency(overallRemaining);
    document.getElementById('budgetHealthPercent').textContent = `${healthPercent}% spent`;
  }

  // ===========================================================================
  // Page 6: Goals Page (Section 13)
  // ===========================================================================
  renderGoals() {
    const grid = document.getElementById('goalsGrid');
    const emptyState = document.getElementById('goalsEmptyState');
    if (!grid) return;

    grid.innerHTML = '';

    if (store.state.goals.length === 0) {
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    store.state.goals.forEach(goal => {
      const current = goal.current || 0;
      const target = goal.target || 1;
      const pct = Math.min(100, Math.round((current / target) * 100));
      const remaining = Math.max(0, target - current);

      const card = document.createElement('div');
      card.className = 'goal-card';
      card.innerHTML = `
        <div class="goal-card-head">
          <span class="goal-title">${escapeHTML(goal.name)}</span>
          ${goal.date ? `<span class="goal-date-tag">Target: ${goal.date}</span>` : ''}
        </div>
        <div class="goal-progress-wrap">
          <div class="goal-progress-track">
            <div class="goal-progress-fill" style="width: ${pct}%"></div>
          </div>
          <div class="goal-values-row">
            <span class="goal-current-val">${formatCurrency(current)}</span>
            <span class="goal-target-val">${pct}% of ${formatCurrency(target)}</span>
          </div>
        </div>
        <div class="goal-footer-actions">
          <span class="text-muted" style="font-size:0.75rem;">${remaining > 0 ? `${formatCurrency(remaining)} to go` : 'Goal achieved!'}</span>
          <div class="table-action-btns">
            <button class="btn btn-secondary btn-sm" data-deposit-goal="${goal.id}">+ Add Funds</button>
            <button class="btn btn-secondary btn-sm" data-edit-goal="${goal.id}"><i data-lucide="edit-3"></i> Edit</button>
            <button class="btn-icon-sm delete" data-delete-goal="${goal.id}"><i data-lucide="trash-2"></i></button>
          </div>
        </div>
      `;

      card.querySelector('[data-deposit-goal]').addEventListener('click', () => {
        const amt = prompt(`Add saved funds to "${goal.name}" (${currencySymbol()}):`, '100');
        if (amt && !isNaN(amt) && parseFloat(amt) > 0) {
          goal.current = (goal.current || 0) + parseFloat(amt);
          store.saveState();
          showToast(`Added ${formatCurrency(parseFloat(amt))} to goal`, 'success');
          this.renderGoals();
        }
      });

      card.querySelector('[data-delete-goal]').addEventListener('click', () => {
        store.state.goals = store.state.goals.filter(g => g.id !== goal.id);
        store.saveState();
        showToast('Goal deleted', 'info');
        this.renderGoals();
      });

      card.querySelector('[data-edit-goal]').addEventListener('click', () => {
        this.openGoalModal(goal);
      });

      grid.appendChild(card);
    });
  }

  // ===========================================================================
  // Page 7: Documents Vault (Section 14)
  // ===========================================================================
  renderDocuments() {
    const tableBody = document.getElementById('documentTableBody');
    const emptyState = document.getElementById('docEmptyState');
    const vaultCount = document.getElementById('docVaultCount');
    if (!tableBody) return;

    if (vaultCount) vaultCount.textContent = `${store.state.documents.length} document${store.state.documents.length === 1 ? '' : 's'}`;

    const lastSync = store.state.driveSync?.lastSync;
    const lastSyncEl = document.getElementById('docDriveLastSync');
    if (lastSyncEl) lastSyncEl.textContent = lastSync ? new Date(lastSync).toLocaleString() : 'Not synced yet';

    tableBody.innerHTML = '';

    if (store.state.documents.length === 0) {
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    store.state.documents.forEach(doc => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHTML(doc.filename)}</strong></td>
        <td><span class="badge badge-neutral">${escapeHTML(doc.mimeType || 'Document')}</span></td>
        <td class="font-mono text-muted">${formatBytes(doc.size || 1024)}</td>
        <td><span class="badge ${doc.source === 'google-drive' ? 'badge-blue' : 'badge-purple'}">${doc.source}</span></td>
        <td><span class="badge ${doc.status === 'stored' ? 'badge-green' : doc.status === 'review' ? 'badge-orange' : 'badge-neutral'}">${doc.status}</span></td>
        <td class="text-muted" style="font-size:0.8rem;">${doc.createdAt?.substring(0, 10) || 'Recent'}</td>
        <td class="text-center">
          <div class="table-action-btns">
            <button class="btn-icon-sm delete" data-delete-doc="${doc.id}"><i data-lucide="trash-2"></i></button>
          </div>
        </td>
      `;

      tr.querySelector('[data-delete-doc]').addEventListener('click', () => {
        store.state.documents = store.state.documents.filter(d => d.id !== doc.id);
        store.saveState();
        showToast('Document deleted', 'info');
        this.renderDocuments();
      });

      tableBody.appendChild(tr);
    });
  }

  // ===========================================================================
  // Page 9: Settings Page (Section 16)
  // ===========================================================================
  renderSettings() {
    this.renderLiveMarketUI();
    const assetsInput = document.getElementById('settingAssetsInput');
    const liabInput = document.getElementById('settingLiabilitiesInput');
    const previewVal = document.getElementById('settingsNetWorthPreview');

    if (assetsInput && liabInput) {
      if (store.state.netWorthConfigured) {
        assetsInput.value = store.state.assetsTotal || '';
        liabInput.value = store.state.liabilitiesTotal || '';
        const net = (store.state.assetsTotal || 0) - (store.state.liabilitiesTotal || 0);
        previewVal.textContent = formatCurrency(net);
        previewVal.className = `preview-value ${net >= 0 ? 'text-green' : 'text-danger'}`;
      } else {
        assetsInput.value = '';
        liabInput.value = '';
        previewVal.textContent = 'Not configured';
        previewVal.className = 'preview-value text-muted';
      }
    }

    // Categories list
    const catList = document.getElementById('settingsCategoriesList');
    if (catList) {
      catList.innerHTML = store.state.categories.map(c => `
        <span class="chip">
          <span>${escapeHTML(c)}</span>
          <span class="chip-remove" data-del-cat="${escapeHTML(c)}">&times;</span>
        </span>
      `).join('');

      catList.querySelectorAll('[data-del-cat]').forEach(btn => {
        btn.addEventListener('click', () => {
          const cat = btn.getAttribute('data-del-cat');
          store.state.categories = store.state.categories.filter(c => c !== cat);
          store.saveState();
          showToast(`Category "${cat}" removed from pickers`, 'info');
          this.renderSettings();
          this.populateDropdowns();
        });
      });
    }

    // Accounts list
    const accList = document.getElementById('settingsAccountsList');
    if (accList) {
      accList.innerHTML = store.state.accounts.map(a => `
        <span class="chip">
          <span>${escapeHTML(a)}</span>
          <span class="chip-remove" data-del-acc="${escapeHTML(a)}">&times;</span>
        </span>
      `).join('');

      accList.querySelectorAll('[data-del-acc]').forEach(btn => {
        btn.addEventListener('click', () => {
          const acc = btn.getAttribute('data-del-acc');
          store.state.accounts = store.state.accounts.filter(a => a !== acc);
          store.saveState();
          showToast(`Account "${acc}" removed`, 'info');
          this.renderSettings();
          this.populateDropdowns();
        });
      });
    }

    this.applyPrefsUI();

    // Ignored suggestions count
    const ignoredCount = document.getElementById('ignoredPatternsCount');
    if (ignoredCount) {
      ignoredCount.textContent = (store.state.dismissedPatterns || []).length;
    }

    // Account Termination list (admin only)
    this.renderSettingsTermination();
  }

  renderSettingsTermination() {
    const list = document.getElementById('settingsTerminationList');
    if (!list) return;
    const users = accounts.list.filter(a => a.role !== 'admin' && (a.terminated || a.active === false));
    if (!users.length) {
      list.innerHTML = '<div class="empty-state-card"><i data-lucide="users"></i><h3>No terminated or inactive accounts</h3><p>Accounts marked terminated or deactivated will appear here.</p></div>';
      this.refreshIcons();
      return;
    }
    list.innerHTML = users.map(u => {
      const terminated = !!u.terminated;
      const inactive = u.active === false && !terminated;
      const statusText = terminated ? 'Terminated' : (inactive ? 'Inactive' : 'Active');
      const statusBadge = terminated ? 'badge-danger' : (inactive ? 'badge-orange' : 'badge-green');
      const canRecover = !terminated;
      return `
        <div class="suggestion-card">
          <div class="sugg-meta-left">
            <div class="sugg-title-row">
              <span class="avatar" style="background:${avatarColor(u.name)};width:32px;height:32px;font-size:0.85rem;display:flex;align-items:center;justify-content:center;border-radius:8px">${escapeHTML(u.name.charAt(0).toUpperCase())}</span>
              <strong class="sugg-name">${escapeHTML(u.name)}</strong>
              <span class="badge ${statusBadge}">${statusText}</span>
            </div>
            <div class="sugg-details-row">
              <span class="text-muted">${escapeHTML(u.email || 'No Gmail')}</span>
              <span class="text-muted">${u.isCloud ? 'Cloud' : 'Local'}</span>
            </div>
          </div>
          <div class="sugg-actions-right">
            ${canRecover ? `<button class="btn btn-secondary btn-sm" onclick="app.adminRecover('${u.id}')"><i data-lucide="rotate-ccw"></i> Recover</button>` : ''}
            ${terminated ? `<button class="btn btn-danger btn-sm" onclick="app.adminDelete('${u.id}')" disabled><i data-lucide="trash-2"></i> Delete</button>` : `<button class="btn btn-danger btn-sm" onclick="app.adminTerminate('${u.id}')"><i data-lucide="shield-off"></i> Terminate</button>`}
          </div>
        </div>`;
    }).join('');
    this.refreshIcons();
  }

  // Populate dynamic category and account selects across modals
  populateDropdowns() {
    const fillSelect = (id, items, defaultVal) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = items.map(item => `
        <option value="${escapeHTML(item)}" ${item === defaultVal ? 'selected' : ''}>${escapeHTML(item)}</option>
      `).join('');
    };

    fillSelect('entryCategory', store.state.categories, 'Needs review');
    fillSelect('entryAccount', store.state.accounts, 'Main Checking');
    fillSelect('budgetCategorySelect', store.state.categories, 'Groceries');
    fillSelect('recCategorySelect', store.state.categories, 'Utilities');
    fillSelect('recAccountSelect', store.state.accounts, 'Main Checking');
    fillSelect('subCategorySelect', store.state.categories, 'Subscriptions');
    fillSelect('subAccountSelect', store.state.accounts, 'Everyday Visa');
    fillSelect('ruleThenCategorySelect', store.state.categories, 'Dining');

    // Transactions page filters
    const txCatFilter = document.getElementById('txCategoryFilter');
    if (txCatFilter) {
      const cur = txCatFilter.value;
      txCatFilter.innerHTML = '<option value="">All Categories</option>' + 
        store.state.categories.map(c => `<option value="${escapeHTML(c)}" ${c === cur ? 'selected' : ''}>${escapeHTML(c)}</option>`).join('');
    }

    const txAccFilter = document.getElementById('txAccountFilter');
    if (txAccFilter) {
      const cur = txAccFilter.value;
      txAccFilter.innerHTML = '<option value="">All Accounts</option>' + 
        store.state.accounts.map(a => `<option value="${escapeHTML(a)}" ${a === cur ? 'selected' : ''}>${escapeHTML(a)}</option>`).join('');
    }
  }

  // ===========================================================================
  // Modals & Form Handlers
  // ===========================================================================
  openAddEntryModal(existingTx = null) {
    this.closeAllModals();
    const modal = document.getElementById('modalAddEntry');
    const title = document.getElementById('entryModalTitle');
    const form = document.getElementById('formAddEntry');
    form.reset();

    const dateInput = document.getElementById('entryDate');
    dateInput.value = new Date().toISOString().split('T')[0];

    if (existingTx) {
      title.textContent = 'Edit Transaction';
      document.getElementById('entryTxId').value = existingTx.id;
      document.getElementById('entryAmount').value = existingTx.amount;
      document.getElementById('entryMerchant').value = existingTx.merchant;
      dateInput.value = existingTx.date;
      document.getElementById('entryCategory').value = existingTx.category;
      document.getElementById('entryAccount').value = existingTx.account;

      if (existingTx.type === 'income') {
        document.getElementById('segmentIncome').click();
      } else {
        document.getElementById('segmentExpense').click();
      }
    } else {
      title.textContent = 'Add Transaction';
      document.getElementById('entryTxId').value = '';
      document.getElementById('segmentExpense').click();
    }

    modal.classList.add('active');
  }

  bindAddEntryForm() {
    let currentType = 'expense';
    const segExpense = document.getElementById('segmentExpense');
    const segIncome = document.getElementById('segmentIncome');

    segExpense?.addEventListener('click', () => {
      currentType = 'expense';
      segExpense.classList.add('active');
      segIncome.classList.remove('active');
    });

    segIncome?.addEventListener('click', () => {
      currentType = 'income';
      segIncome.classList.add('active');
      segExpense.classList.remove('active');
    });

    // Receipt checkbox toggle
    const receiptCheck = document.getElementById('entryHasReceipt');
    const uploadBox = document.getElementById('entryReceiptUploadBox');
    receiptCheck?.addEventListener('change', () => {
      if (uploadBox) uploadBox.style.display = receiptCheck.checked ? 'block' : 'none';
    });

    // Form submit
    document.getElementById('formAddEntry')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const txId = document.getElementById('entryTxId').value;
      const amount = parseFloat(document.getElementById('entryAmount').value);
      const merchant = document.getElementById('entryMerchant').value.trim();
      const date = document.getElementById('entryDate').value;
      const category = document.getElementById('entryCategory').value;
      const account = document.getElementById('entryAccount').value;
      const hasReceipt = document.getElementById('entryHasReceipt').checked;

      if (!merchant || isNaN(amount) || amount <= 0) {
        showToast('Please provide a valid merchant and amount', 'error');
        return;
      }

      const saveBtn = document.getElementById('btnSaveEntry');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner spinner-sm"></span> Saving...';

      setTimeout(() => {
      if (txId) {
        // Update existing
        store.updateTransaction(txId, {
          merchant,
          amount,
          date,
          type: currentType,
          category,
          account,
          receipt: hasReceipt
        });
        showToast('Transaction updated', 'success');
      } else {
        // Add new
        const res = store.addTransactions([{
          date,
          merchant,
          amount,
          type: currentType,
          category,
          account,
          receipt: hasReceipt,
          source: 'manual'
        }]);

        if (res.duplicates > 0) {
          showToast('Duplicate transaction detected and skipped', 'error');
        } else {
          notifyTransaction({ merchant, amount, type: currentType, category, date });
        }
      }

      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Transaction';
      this.closeAllModals();
      this.renderAll();
      }, 700);
    });
  }

  // ===========================================================================
  // CSV Import & Document Vault Modal
  // ===========================================================================
  openImportModal() {
    this.closeAllModals();
    const modal = document.getElementById('modalImport');
    document.getElementById('importResultCard').style.display = 'none';
    document.getElementById('csvPreviewSection').style.display = 'none';
    document.getElementById('csvFileInput').value = '';
    modal.classList.add('active');
  }

  bindImportModal() {
    const tabCsv = document.getElementById('importTabCsv');
    const tabDocs = document.getElementById('importTabDocs');
    const secCsv = document.getElementById('importCsvSection');
    const secDocs = document.getElementById('importDocSection');

    tabCsv?.addEventListener('click', () => {
      tabCsv.classList.add('active');
      tabDocs.classList.remove('active');
      secCsv.style.display = 'block';
      secDocs.style.display = 'none';
    });

    tabDocs?.addEventListener('click', () => {
      tabDocs.classList.add('active');
      tabCsv.classList.remove('active');
      secDocs.style.display = 'block';
      secCsv.style.display = 'none';
    });

    // CSV Dropzone
    const dropzone = document.getElementById('csvDropzone');
    const fileInput = document.getElementById('csvFileInput');

    dropzone?.addEventListener('click', () => fileInput.click());
    dropzone?.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length) this.handleCsvFile(e.dataTransfer.files[0]);
    });

    fileInput?.addEventListener('change', (e) => {
      if (e.target.files.length) this.handleCsvFile(e.target.files[0]);
    });

    // Execute Import Button
    document.getElementById('btnExecuteCsvImport')?.addEventListener('click', () => {
      this.executeCsvImport();
    });

    // Documents Vault Dropzone (in page and modal)
    const docDropzone = document.getElementById('documentDropzone');
    const docInput = document.getElementById('docFileInput');
    docDropzone?.addEventListener('click', () => docInput.click());
    docInput?.addEventListener('change', (e) => this.handleDocUpload(e.target.files, 'upload'));

    const modalDocDropzone = document.getElementById('importModalDocDropzone');
    const modalDocInput = document.getElementById('importModalDocInput');
    modalDocDropzone?.addEventListener('click', () => modalDocInput.click());
    modalDocInput?.addEventListener('change', (e) => this.handleDocUpload(e.target.files, 'upload'));
  }

  handleCsvFile(file) {
    if (!file.name.endsWith('.csv')) {
      showToast('Please choose a valid .csv file', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      this.parseCsvContent(text);
    };
    reader.readAsText(file);
  }

  parseCsvContent(content) {
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) {
      showToast('CSV file is empty or missing data rows', 'error');
      return;
    }

    // Split headers
    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
    const rows = lines.slice(1).map(line => {
      // Basic CSV comma splitter handling quotes
      const row = [];
      let inQuote = false;
      let curr = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQuote = !inQuote;
        else if (ch === ',' && !inQuote) {
          row.push(curr.trim());
          curr = '';
        } else {
          curr += ch;
        }
      }
      row.push(curr.trim());
      return row;
    });

    this.pendingCsvData = { headers, rows };

    // Auto-map headers
    const populateSelect = (selectId, guessPatterns) => {
      const el = document.getElementById(selectId);
      el.innerHTML = '<option value="">-- None / Default --</option>' + 
        headers.map((h, idx) => `<option value="${idx}">${escapeHTML(h)}</option>`).join('');

      // Find best match
      const matchedIdx = headers.findIndex(h => {
        const lower = h.toLowerCase();
        return guessPatterns.some(p => lower.includes(p));
      });
      if (matchedIdx !== -1) el.value = matchedIdx;
    };

    populateSelect('mapColDate', ['date', 'time', 'posted']);
    populateSelect('mapColMerchant', ['merchant', 'description', 'payee', 'name', 'details']);
    populateSelect('mapColAmount', ['amount', 'total', 'debit', 'cost']);
    populateSelect('mapColCategory', ['category', 'type']);
    populateSelect('mapColAccount', ['account', 'card', 'bank']);

    // Show Preview Table (First 4 rows)
    const previewTable = document.getElementById('csvPreviewTable');
    let previewHtml = '<tr>' + headers.map(h => `<th>${escapeHTML(h)}</th>`).join('') + '</tr>';
    rows.slice(0, 4).forEach(r => {
      previewHtml += '<tr>' + r.map(c => `<td>${escapeHTML(c)}</td>`).join('') + '</tr>';
    });
    previewTable.innerHTML = previewHtml;

    document.getElementById('csvPreviewSection').style.display = 'block';
  }

  executeCsvImport() {
    if (!this.pendingCsvData) return;

    const dateCol = parseInt(document.getElementById('mapColDate').value);
    const merchCol = parseInt(document.getElementById('mapColMerchant').value);
    const amtCol = parseInt(document.getElementById('mapColAmount').value);
    const catCol = parseInt(document.getElementById('mapColCategory').value);
    const accCol = parseInt(document.getElementById('mapColAccount').value);

    if (isNaN(dateCol) || isNaN(merchCol) || isNaN(amtCol)) {
      showToast('Please select mappings for Date, Merchant, and Amount', 'error');
      return;
    }

    const txToInsert = [];
    let reviewCount = 0;

    this.pendingCsvData.rows.forEach(row => {
      const rawDate = row[dateCol] || '';
      const rawMerch = row[merchCol] || '';
      const rawAmt = row[amtCol] || '';
      const rawCat = !isNaN(catCol) && row[catCol] ? row[catCol] : 'Needs review';
      const rawAcc = !isNaN(accCol) && row[accCol] ? row[accCol] : 'Imported account';

      if (!rawMerch || !rawAmt) return;

      // Normalize date to YYYY-MM-DD
      let normalizedDate = new Date().toISOString().split('T')[0];
      const parsedDate = new Date(rawDate);
      if (!isNaN(parsedDate.getTime())) {
        normalizedDate = parsedDate.toISOString().split('T')[0];
      }

      // Parse amount & debit/credit sign convention
      let num = parseFloat(rawAmt.replace(/[^0-9.-]/g, ''));
      if (isNaN(num)) return;

      const type = num < 0 ? 'expense' : (rawCat.toLowerCase().includes('income') || num > 1000 ? 'income' : 'expense');
      const positiveAmt = Math.abs(num);

      if (rawCat === 'Needs review') reviewCount++;

      txToInsert.push({
        date: normalizedDate,
        merchant: rawMerch,
        amount: positiveAmt,
        type,
        category: store.state.categories.includes(rawCat) ? rawCat : 'Needs review',
        account: rawAcc,
        source: 'csv',
        receipt: false
      });
    });

    const result = store.addTransactions(txToInsert);

    // Show Report
    const resCard = document.getElementById('importResultCard');
    resCard.style.display = 'block';
    document.getElementById('resCountInserted').textContent = result.inserted;
    document.getElementById('resCountDupes').textContent = result.duplicates;
    document.getElementById('resCountReview').textContent = reviewCount;

    showToast(`Imported ${result.inserted} transactions (${result.duplicates} duplicates skipped)`, 'success');
    this.renderAll();
  }

  handleDocUpload(files, source = 'upload') {
    if (!files || !files.length) return;

    let added = 0;
    Array.from(files).forEach(file => {
      if (file.size > 20 * 1024 * 1024) {
        showToast(`File "${file.name}" exceeds 20MB limit`, 'error');
        return;
      }

      store.state.documents.push({
        id: 'doc_' + Date.now() + Math.random().toString(36).substring(2, 6),
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        status: 'stored',
        source,
        createdAt: new Date().toISOString()
      });
      added++;
    });

    store.saveState();
    showToast(`Stored ${added} document(s) in vault`, 'success');
    this.renderDocuments();
  }

  // ===========================================================================
  // Google Drive Sync Modal & Simulation
  // ===========================================================================
  openDriveSyncModal() {
    this.closeAllModals();
    const modal = document.getElementById('modalDriveSync');
    const lastSyncEl = document.getElementById('driveModalLastSync');
    const syncTime = store.state.driveSync?.lastSync;
    lastSyncEl.textContent = syncTime ? new Date(syncTime).toLocaleString() : 'Never';
    document.getElementById('driveSyncResultsBox').style.display = 'none';
    modal.classList.add('active');

    document.getElementById('btnRunDriveSyncNow').onclick = () => {
      this.simulateDriveSync();
    };
  }

  simulateDriveSync() {
    const btn = document.getElementById('btnRunDriveSyncNow');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="refresh-cw" class="spin"></i> Syncing with Google Drive...`;
    this.refreshIcons();

    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="refresh-cw"></i> Check & Sync Drive Inbox Now`;

      const now = new Date().toISOString();
      store.state.driveSync.lastSync = now;
      store.saveState();

      document.getElementById('driveSyncResultsBox').style.display = 'block';
      document.getElementById('driveSyncMsg').textContent = 'Drive Inbox checked. No unimported files found in "Finova Financial Inbox".';
      document.getElementById('sidebarSyncLabel').textContent = 'Synced just now';

      showToast('Google Drive inbox checked. Up to date.', 'success');
      this.renderDocuments();
      this.refreshIcons();
    }, 1200);
  }

  // ===========================================================================
  // Budget & Goal Forms
  // ===========================================================================
  openBudgetModal(existing = null) {
    this.closeAllModals();
    const modal = document.getElementById('modalBudget');
    const form = document.getElementById('formBudget');
    form.reset();

    if (existing) {
      document.getElementById('budgetModalTitle').textContent = 'Edit Budget';
      document.getElementById('budgetId').value = existing.id;
      document.getElementById('budgetCategorySelect').value = existing.category;
      document.getElementById('budgetLimitInput').value = existing.limit;
    } else {
      document.getElementById('budgetModalTitle').textContent = 'Create Monthly Budget';
      document.getElementById('budgetId').value = '';
    }

    modal.classList.add('active');
  }

  openGoalModal(existing = null) {
    this.closeAllModals();
    const modal = document.getElementById('modalGoal');
    const form = document.getElementById('formGoal');
    form.reset();

    if (existing) {
      document.getElementById('goalModalTitle').textContent = 'Edit Goal';
      document.getElementById('goalId').value = existing.id;
      document.getElementById('goalNameInput').value = existing.name;
      document.getElementById('goalTargetInput').value = existing.target;
      document.getElementById('goalCurrentInput').value = existing.current || 0;
      document.getElementById('goalDateInput').value = existing.date || '';
    } else {
      document.getElementById('goalModalTitle').textContent = 'Create Savings Goal';
      document.getElementById('goalId').value = '';
    }

    modal.classList.add('active');
  }

  bindBudgetAndGoalForms() {
    document.getElementById('btnCreateBudget')?.addEventListener('click', () => this.openBudgetModal());
    document.getElementById('btnCreateGoal')?.addEventListener('click', () => this.openGoalModal());

    document.getElementById('formBudget')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('budgetId').value;
      const category = document.getElementById('budgetCategorySelect').value;
      const limit = parseFloat(document.getElementById('budgetLimitInput').value);

      if (id) {
        const item = store.state.budgets.find(b => b.id === id);
        if (item) {
          item.category = category;
          item.limit = limit;
        }
      } else {
        // Prevent duplicate category budget
        store.state.budgets = store.state.budgets.filter(b => b.category !== category);
        store.state.budgets.push({
          id: 'bgt_' + Date.now(),
          category,
          limit,
          active: true
        });
      }

      store.saveState();
      showToast('Budget saved', 'success');
      this.closeAllModals();
      this.renderBudgets();
    });

    document.getElementById('formGoal')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('goalId').value;
      const name = document.getElementById('goalNameInput').value.trim();
      const target = parseFloat(document.getElementById('goalTargetInput').value);
      const current = parseFloat(document.getElementById('goalCurrentInput').value) || 0;
      const date = document.getElementById('goalDateInput').value;

      if (id) {
        const item = store.state.goals.find(g => g.id === id);
        if (item) {
          item.name = name;
          item.target = target;
          item.current = current;
          item.date = date;
        }
      } else {
        store.state.goals.push({
          id: 'goal_' + Date.now(),
          name,
          target,
          current,
          date
        });
      }

      store.saveState();
      showToast('Goal saved', 'success');
      this.closeAllModals();
      this.renderGoals();
    });
  }

  // ===========================================================================
  // Recurring & Subscriptions Forms
  // ===========================================================================
  openAddRecurringModal(existing = null) {
    this.closeAllModals();
    const modal = document.getElementById('modalRecurring');
    const form = document.getElementById('formRecurring');
    form.reset();

    if (existing) {
      document.getElementById('recurringModalTitle').textContent = 'Edit Recurring Payment';
      document.getElementById('recurringId').value = existing.id;
      document.getElementById('recNameInput').value = existing.name;
      document.getElementById('recAmountInput').value = existing.amount;
      document.getElementById('recCadenceSelect').value = existing.cadence;
      document.getElementById('recCategorySelect').value = existing.category;
      document.getElementById('recNextDateInput').value = existing.nextDate;
      document.getElementById('recAccountSelect').value = existing.account || 'Main Checking';
    } else {
      document.getElementById('recurringModalTitle').textContent = 'Add Recurring Payment';
      document.getElementById('recurringId').value = '';
      document.getElementById('recNextDateInput').value = new Date().toISOString().split('T')[0];
    }

    modal.classList.add('active');
  }

  openAddSubscriptionModal(existing = null) {
    this.closeAllModals();
    const modal = document.getElementById('modalSubscription');
    const form = document.getElementById('formSubscription');
    form.reset();

    if (existing) {
      document.getElementById('subModalTitle').textContent = 'Edit Subscription';
      document.getElementById('subId').value = existing.id;
      document.getElementById('subNameInput').value = existing.name;
      document.getElementById('subAmountInput').value = existing.amount;
      document.getElementById('subCadenceSelect').value = existing.cadence;
      document.getElementById('subCategorySelect').value = existing.category;
      document.getElementById('subNextDateInput').value = existing.nextDate;
      document.getElementById('subAccountSelect').value = existing.account || 'Everyday Visa';
    } else {
      document.getElementById('subModalTitle').textContent = 'Add Subscription';
      document.getElementById('subId').value = '';
      document.getElementById('subNextDateInput').value = new Date().toISOString().split('T')[0];
    }

    modal.classList.add('active');
  }

  bindRecurringAndSubForms() {
    document.getElementById('btnAddRecurring')?.addEventListener('click', () => this.openAddRecurringModal());
    document.getElementById('btnAddSubscription')?.addEventListener('click', () => this.openAddSubscriptionModal());

    document.getElementById('formRecurring')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('recurringId').value;
      const name = document.getElementById('recNameInput').value.trim();
      const amount = parseFloat(document.getElementById('recAmountInput').value);
      const cadence = document.getElementById('recCadenceSelect').value;
      const category = document.getElementById('recCategorySelect').value;
      const nextDate = document.getElementById('recNextDateInput').value;
      const account = document.getElementById('recAccountSelect').value;

      if (id) {
        const item = store.state.recurring.find(r => r.id === id);
        if (item) Object.assign(item, { name, amount, cadence, category, nextDate, account });
      } else {
        store.state.recurring.push({
          id: 'rec_' + Date.now(),
          name,
          amount,
          cadence,
          category,
          nextDate,
          account,
          active: true
        });
      }

      store.saveState();
      showToast('Recurring payment saved', 'success');
      this.closeAllModals();
      this.renderRecurring();
    });

    document.getElementById('formSubscription')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('subId').value;
      const name = document.getElementById('subNameInput').value.trim();
      const amount = parseFloat(document.getElementById('subAmountInput').value);
      const cadence = document.getElementById('subCadenceSelect').value;
      const category = document.getElementById('subCategorySelect').value;
      const nextDate = document.getElementById('subNextDateInput').value;
      const account = document.getElementById('subAccountSelect').value;

      if (id) {
        const item = store.state.subscriptions.find(s => s.id === id);
        if (item) Object.assign(item, { name, amount, cadence, category, nextDate, account });
      } else {
        store.state.subscriptions.push({
          id: 'sub_' + Date.now(),
          name,
          amount,
          cadence,
          category,
          nextDate,
          account,
          active: true
        });
      }

      store.saveState();
      showToast('Subscription saved', 'success');
      this.closeAllModals();
      this.renderSubscriptions();
    });
  }

  // ===========================================================================
  // Settings & Danger Zone Wipe
  // ===========================================================================
  bindSettings() {
    // Live Net Worth Preview calculation
    const assetsInput = document.getElementById('settingAssetsInput');
    const liabInput = document.getElementById('settingLiabilitiesInput');
    const previewVal = document.getElementById('settingsNetWorthPreview');

    const updatePreview = () => {
      const a = parseFloat(assetsInput.value) || 0;
      const l = parseFloat(liabInput.value) || 0;
      const net = a - l;
      previewVal.textContent = formatCurrency(net);
      previewVal.className = `preview-value ${net >= 0 ? 'text-green' : 'text-danger'}`;
    };

    assetsInput?.addEventListener('input', updatePreview);
    liabInput?.addEventListener('input', updatePreview);

    document.getElementById('btnSaveNetWorth')?.addEventListener('click', () => {
      const a = parseFloat(assetsInput.value) || 0;
      const l = parseFloat(liabInput.value) || 0;

      store.state.assetsTotal = a;
      store.state.liabilitiesTotal = l;
      store.state.netWorthConfigured = true;
      store.saveState();

      showToast('Net Worth totals configured and saved', 'success');
      this.renderAll();
    });

    // Add Category
    document.getElementById('btnAddCategory')?.addEventListener('click', () => {
      const input = document.getElementById('newCategoryInput');
      const val = input.value.trim();
      if (val && !store.state.categories.includes(val)) {
        store.state.categories.push(val);
        store.saveState();
        input.value = '';
        showToast(`Category "${val}" added`, 'success');
        this.renderSettings();
        this.populateDropdowns();
      }
    });

    // Add Account
    document.getElementById('btnAddAccount')?.addEventListener('click', () => {
      const input = document.getElementById('newAccountInput');
      const val = input.value.trim();
      if (val && !store.state.accounts.includes(val)) {
        store.state.accounts.push(val);
        store.saveState();
        input.value = '';
        showToast(`Account "${val}" added`, 'success');
        this.renderSettings();
        this.populateDropdowns();
      }
    });

    // Restore Ignored Suggestions
    document.getElementById('btnRestoreIgnoredPatterns')?.addEventListener('click', () => {
      store.state.dismissedPatterns = [];
      store.saveState();
      showToast('Ignored patterns restored to active detection', 'success');
      this.renderAll();
    });

    // Danger Zone Wipe Modal (Section 16.5)
    const wipeModal = document.getElementById('modalWipe');
    const wipeInput = document.getElementById('wipeConfirmInput');
    const wipeBtn = document.getElementById('btnExecuteDataWipe');

    document.getElementById('btnOpenWipeModal')?.addEventListener('click', () => {
      this.closeAllModals();
      wipeInput.value = '';
      wipeBtn.disabled = true;
      wipeModal.classList.add('active');
    });

    wipeInput?.addEventListener('input', (e) => {
      wipeBtn.disabled = e.target.value !== 'DELETE';
    });

    wipeBtn?.addEventListener('click', () => {
      if (wipeInput.value === 'DELETE') {
        store.wipeAllData();
        this.selectedPeriod = 'all-time';
        this.closeAllModals();
        showToast('All Finova data has been erased', 'error');
        this.renderAll();
      }
    });
  }

  // ===========================================================================
  // Demo Data Generator (For Testing)
  // ===========================================================================
  toggleDemoData() {
    if (store.state.transactions.length > 0) {
      if (confirm('Reset dashboard to empty-start contract state?')) {
        store.wipeAllData();
        showToast('Dashboard reset to clean empty state', 'info');
        this.renderAll();
      }
      return;
    }

    // Populate realistic demo dataset
    const today = new Date();
    const formatDate = (offsetDays) => {
      const d = new Date(today);
      d.setDate(d.getDate() - offsetDays);
      return d.toISOString().split('T')[0];
    };

    const sampleTx = [
      { date: formatDate(1), merchant: 'Trader Joe\'s', amount: 84.50, type: 'expense', category: 'Groceries', account: 'Everyday Visa', tags: ['Food'] },
      { date: formatDate(2), merchant: 'Uber Technologies', amount: 24.80, type: 'expense', category: 'Transportation', account: 'Everyday Visa', tags: ['Travel'] },
      { date: formatDate(4), merchant: 'Employer Direct Deposit', amount: 3450.00, type: 'income', category: 'Income', account: 'Main Checking', tags: ['Salary'] },
      { date: formatDate(7), merchant: 'Netflix', amount: 19.99, type: 'expense', category: 'Subscriptions', account: 'Everyday Visa', tags: ['Entertainment'] },
      { date: formatDate(9), merchant: 'Spotify', amount: 10.99, type: 'expense', category: 'Subscriptions', account: 'Everyday Visa', tags: [] },
      { date: formatDate(11), merchant: 'Blue Bottle Coffee', amount: 6.75, type: 'expense', category: 'Dining', account: 'Everyday Visa', tags: ['Coffee'] },
      { date: formatDate(14), merchant: 'Target', amount: 112.30, type: 'expense', category: 'Shopping', account: 'Everyday Visa', tags: [] },
      { date: formatDate(20), merchant: 'Pacific Gas & Electric', amount: 145.20, type: 'expense', category: 'Utilities', account: 'Main Checking', tags: ['Bills'] },
      { date: formatDate(28), merchant: 'Apex Properties Rent', amount: 1850.00, type: 'expense', category: 'Housing', account: 'Main Checking', tags: ['Housing'] },
      { date: formatDate(35), merchant: 'Netflix', amount: 19.99, type: 'expense', category: 'Subscriptions', account: 'Everyday Visa', tags: [] },
      { date: formatDate(38), merchant: 'Spotify', amount: 10.99, type: 'expense', category: 'Subscriptions', account: 'Everyday Visa', tags: [] },
      { date: formatDate(58), merchant: 'Apex Properties Rent', amount: 1850.00, type: 'expense', category: 'Housing', account: 'Main Checking', tags: [] }
    ];

    store.addTransactions(sampleTx);

    // Set demo net worth
    store.state.assetsTotal = 24500;
    store.state.liabilitiesTotal = 4200;
    store.state.netWorthConfigured = true;

    // Set sample budgets & goals
    store.state.budgets = [
      { id: 'b1', category: 'Groceries', limit: 500, active: true },
      { id: 'b2', category: 'Dining', limit: 250, active: true },
      { id: 'b3', category: 'Shopping', limit: 300, active: true }
    ];

    store.state.goals = [
      { id: 'g1', name: 'Emergency Fund', target: 10000, current: 6500, date: '2026-12-31' },
      { id: 'g2', name: 'Vacation to Japan', target: 4000, current: 2400, date: '2027-04-15' }
    ];

    store.state.subscriptions = [
      { id: 's1', name: 'Netflix Premium', category: 'Subscriptions', amount: 19.99, cadence: 'monthly', nextDate: formatDate(-15), account: 'Everyday Visa', active: true },
      { id: 's2', name: 'Spotify Duo', category: 'Subscriptions', amount: 10.99, cadence: 'monthly', nextDate: formatDate(-20), account: 'Everyday Visa', active: true }
    ];

    store.state.recurring = [
      { id: 'r1', name: 'Apartment Rent', category: 'Housing', amount: 1850.00, cadence: 'monthly', nextDate: formatDate(-10), account: 'Main Checking', active: true }
    ];

    store.saveState();
    showToast('Loaded demo dataset! Click "Demo Data" anytime to reset', 'success');
    this.renderAll();
  }

  closeAllModals() {
    document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('active'));
  }
}

// =============================================================================
// Helper Utilities
// =============================================================================
function formatCurrency(val) {
  const num = Number(val) || 0;
  try {
    return new Intl.NumberFormat((LANG_META[prefs.lang] || LANG_META.en).locale, { style: 'currency', currency: prefs.currency, currencyDisplay: 'narrowSymbol' }).format(num);
  } catch (e) {
    return prefs.currency + ' ' + num.toFixed(2);
  }
}

function currencySymbol() {
  try {
    const part = new Intl.NumberFormat((LANG_META[prefs.lang] || LANG_META.en).locale, { style: 'currency', currency: prefs.currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find(p => p.type === 'currency');
    return part ? part.value : prefs.currency;
  } catch (e) {
    return prefs.currency;
  }
}

// Simple demo hash so passwords are not stored as plain text (NOT real security)
function hashPass(p) {
  let h = 5381;
  for (const c of 'finova:' + p) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return h.toString(16);
}

function avatarColor(name) {
  const colors = ['#4338ca', '#0a8159', '#cf4a1a', '#2563eb', '#7c3aed', '#be185d', '#0e7490'];
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return colors[h % colors.length];
}

// Rich notification shown when a transaction is added
function notifyTransaction(tx) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const isIncome = tx.type === 'income';
  const el = document.createElement('div');
  el.className = 'toast tx-notify ' + (isIncome ? 'income' : 'expense');
  el.innerHTML = `
    <span class="tx-notify-icon"><i data-lucide="${isIncome ? 'arrow-down-left' : 'arrow-up-right'}"></i></span>
    <div class="tx-notify-body">
      <strong>Transaction added</strong>
      <span>${escapeHTML(tx.merchant)} &bull; ${isIncome ? '+' : '-'}${formatCurrency(tx.amount)}</span>
      <small>${escapeHTML(tx.category)} &bull; ${escapeHTML(tx.date)}</small>
    </div>
  `;
  container.appendChild(el);
  if (window.lucide) window.lucide.createIcons();
  setTimeout(() => {
    el.style.transition = 'all 0.25s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 250);
  }, 4500);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${escapeHTML(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 3200);
}

// =============================================================================
// Language support (English / Filipino)
// Text is translated in place from this dictionary. English is the source;
// anything missing from the dictionary simply stays in English.
// =============================================================================
const FIL = {
  // Shell & navigation
  'Private Finance': 'Pribadong Pananalapi', 'Transactions': 'Mga Transaksyon', 'Recurring': 'Paulit-ulit',
  'Subscriptions': 'Mga Subscription', 'Budgets': 'Mga Badyet', 'Goals': 'Mga Layunin', 'Documents': 'Mga Dokumento',
  'Settings': 'Mga Setting', '8:00 AM Daily': '8:00 AM Araw-araw', 'Switch': 'Palitan', 'Switch account': 'Palitan ang account',
  'Total Income': 'Kabuuang Kita', 'Import': 'Mag-import', 'Add entry': 'Magdagdag',
  'Loading Finova...': 'Nilo-load ang Finova...', 'Loading Admin interface...': 'Nilo-load ang Admin interface...',
  'Loading User interface...': 'Nilo-load ang User interface...', 'Loading transactions...': 'Nilo-load ang mga transaksyon...',
  "Who's using Finova?": 'Sino ang gagamit ng Finova?', 'Choose an account to continue': 'Pumili ng account para magpatuloy',
  'Add account': 'Magdagdag ng account', 'Account name': 'Pangalan ng account', 'Create': 'Gumawa', 'Cancel': 'Kanselahin',
  'Current': 'Kasalukuyan', 'Remove account': 'Alisin ang account', 'Close': 'Isara', 'Done': 'Tapos',
  // Page titles
  'Personal financial overview': 'Pangkalahatang pananalapi', 'All recorded expenses and income': 'Lahat ng gastos at kita',
  'Recurring Payments': 'Mga Paulit-ulit na Bayad', 'Active subscriptions and bills detection': 'Mga aktibong subscription at bayarin',
  'Track your recurring service renewals': 'Subaybayan ang mga renewal', 'Monthly spend limits and category caps': 'Buwanang limitasyon sa gastos',
  'Savings Goals': 'Mga Layunin sa Ipon', 'Progress towards financial milestones': 'Pag-usad sa mga layunin',
  'Documents Vault': 'Vault ng Dokumento', 'Receipts, statements, and Drive sync': 'Mga resibo, statement, at Drive sync',
  'Net worth, categories, accounts, and system': 'Net worth, kategorya, account, at sistema',
  // Period
  'Date Period:': 'Panahon:', 'All time': 'Lahat ng panahon', 'This week': 'Ngayong linggo', 'This month': 'Ngayong buwan', 'This year': 'Ngayong taon',
  // Dashboard
  'Not set': 'Hindi pa naitakda', 'Assets minus liabilities': 'Assets bawas liabilities', 'Configure in Settings': 'I-set sa Settings',
  'Total Spending': 'Kabuuang Gastos', 'Savings Rate': 'Rate ng Ipon', 'No trend yet': 'Wala pang trend',
  'Formula: (Income − Spending) ÷ Income': 'Pormula: (Kita − Gastos) ÷ Kita',
  'Cash Flow': 'Daloy ng Pera', 'Monthly income vs expenses over time': 'Buwanang kita laban sa gastos', 'Income': 'Kita', 'Spending': 'Gastos',
  'No cash flow data': 'Walang datos ng daloy ng pera', 'Import or add transactions to see cash flow.': 'Mag-import o magdagdag ng transaksyon.',
  'Add transaction': 'Magdagdag ng transaksyon', 'Spending by Category': 'Gastos kada Kategorya',
  'Expense distribution in selected period': 'Hatian ng gastos sa napiling panahon', 'No expenses yet': 'Wala pang gastos',
  'Spend categories will appear here once recorded.': 'Lalabas dito ang mga kategorya ng gastos.',
  'Recent Activity': 'Kamakailang Aktibidad', 'Latest records in selected period': 'Pinakabagong tala sa napiling panahon',
  'View all': 'Tingnan lahat', 'Finova Insights': 'Mga Insight', 'Coming Up': 'Paparating', 'Upcoming bills & renewals': 'Mga paparating na bayarin',
  'Manage': 'Ayusin', 'System Status: Active': 'Katayuan ng Sistema: Aktibo',
  'No activity in this period. Add an entry or import a CSV statement.': 'Walang aktibidad sa panahong ito. Magdagdag o mag-import ng CSV.',
  'All Categories Assigned': 'Naitakda na ang lahat ng kategorya', 'All transactions in this period have assigned categories.': 'May kategorya na ang lahat ng transaksyon sa panahong ito.',
  // Transactions
  'Search merchant or category...': 'Maghanap ng merchant o kategorya...', 'All Categories': 'Lahat ng Kategorya', 'All Accounts': 'Lahat ng Account',
  'Reset': 'I-reset', 'Date & Merchant': 'Petsa at Merchant', 'Category': 'Kategorya', 'Account': 'Account', 'Receipt': 'Resibo', 'Amount': 'Halaga',
  'Actions': 'Aksyon', 'No transactions found': 'Walang nahanap na transaksyon', 'No records match your selected period or filters.': 'Walang tugma sa napiling panahon o filter.',
  'Import CSV': 'Mag-import ng CSV',
  // Recurring & subscriptions
  'Detected Recurring Suggestions': 'Mga Natukoy na Paulit-ulit', 'Monthly Commitment': 'Buwanang Obligasyon', 'Annual Commitment': 'Taunang Obligasyon',
  'Next Expected Payment': 'Susunod na Bayad', 'None scheduled': 'Walang nakatakda', 'Confirmed Recurring Payments': 'Kumpirmadong Paulit-ulit na Bayad',
  'Add recurring payment': 'Magdagdag ng paulit-ulit na bayad', 'Name': 'Pangalan', 'Cadence': 'Dalas', 'Next Expected Date': 'Susunod na Petsa',
  'Monthly Equiv.': 'Buwanang Katumbas', 'Status': 'Katayuan', 'No confirmed recurring payments': 'Walang kumpirmadong paulit-ulit na bayad',
  'Ignore': 'Huwag pansinin', 'Keep': 'Panatilihin', 'Confirm': 'Kumpirmahin', 'Active': 'Aktibo', 'Paused': 'Naka-pause',
  'Subscription Candidates': 'Mga Posibleng Subscription', 'Monthly Subscriptions': 'Buwanang Subscription', 'Annual Cost': 'Taunang Gastos',
  'Active Services': 'Mga Aktibong Serbisyo', 'Next Renewal': 'Susunod na Renewal', 'Active Subscriptions': 'Mga Aktibong Subscription',
  'Add subscription': 'Magdagdag ng subscription', 'Service Name': 'Pangalan ng Serbisyo', 'Billing Cycle': 'Billing Cycle',
  'Next Renewal Date': 'Petsa ng Susunod na Renewal', 'Payment Account': 'Account ng Bayad', 'No subscriptions tracked': 'Walang subscription',
  // Budgets
  'Monthly Budget Health': 'Kalagayan ng Buwanang Badyet', 'Create budget': 'Gumawa ng badyet', 'Total Budget': 'Kabuuang Badyet',
  'Total Spent': 'Kabuuang Nagastos', 'Remaining': 'Natitira', 'Overall Health': 'Pangkalahatang Kalagayan', 'No budgets set up yet': 'Wala pang badyet',
  'Create your first budget': 'Gawin ang unang badyet', 'Create Monthly Budget': 'Gumawa ng Buwanang Badyet', 'Edit Budget': 'I-edit ang Badyet', 'Save Budget': 'I-save ang Badyet',
  // Goals
  'Savings & Financial Goals': 'Mga Layunin sa Ipon at Pananalapi', 'Create goal': 'Gumawa ng layunin', 'No savings goals created': 'Wala pang layunin sa ipon',
  'Set a goal': 'Magtakda ng layunin', 'Edit': 'I-edit', '+ Add Funds': '+ Magdagdag ng Pondo', 'Goal achieved!': 'Naabot ang layunin!',
  'Create Savings Goal': 'Gumawa ng Layunin sa Ipon', 'Edit Goal': 'I-edit ang Layunin', 'Goal Name': 'Pangalan ng Layunin', 'Save Goal': 'I-save ang Layunin',
  'Target Date (optional)': 'Target na Petsa (opsyonal)',
  // Documents
  'Upload Documents': 'Mag-upload ng Dokumento', 'Secure Document Vault': 'Ligtas na Vault ng Dokumento', 'Filename': 'Pangalan ng File',
  'Type': 'Uri', 'Size': 'Laki', 'Source': 'Pinagmulan', 'Imported Date': 'Petsa ng Import', 'No documents yet': 'Wala pang dokumento',
  'Upload a file or add one to your Drive inbox.': 'Mag-upload ng file o ilagay sa Drive inbox.', 'browse': 'mag-browse',
  'Drag & drop files here, or': 'I-drag at i-drop ang mga file dito, o',
  // Settings
  'Preferences': 'Mga Kagustuhan', 'Language and currency used across the app': 'Wika at pera na gagamitin sa buong app', 'Language': 'Wika', 'Currency': 'Pera',
  'Changing currency only changes the symbol; amounts are not converted.': 'Simbolo lang ang nagbabago; hindi kino-convert ang mga halaga.',
  'Net Worth Configuration': 'Setup ng Net Worth', 'Calculated Net Worth Preview:': 'Preview ng Net Worth:', 'Not configured': 'Hindi pa naka-set',
  'Save Net Worth': 'I-save ang Net Worth', 'Managed Categories': 'Mga Kategorya', 'Managed Accounts': 'Mga Account', 'Add': 'Idagdag',
  'Danger Zone': 'Delikadong Bahagi', 'Wipe All Data': 'Burahin Lahat ng Data', 'Erase All Data': 'Burahin Lahat ng Data',
  // Modals
  'Add Transaction': 'Magdagdag ng Transaksyon', 'Edit Transaction': 'I-edit ang Transaksyon', 'Expense': 'Gastos', 'Merchant or Source': 'Merchant o Pinagmulan',
  'Date': 'Petsa', 'Save Transaction': 'I-save ang Transaksyon', 'Saving...': 'Sine-save...',
  'I have a receipt or invoice to attach': 'Mayroon akong resibo o invoice na ia-attach',
  'Add Recurring Payment': 'Magdagdag ng Paulit-ulit na Bayad', 'Edit Recurring Payment': 'I-edit ang Paulit-ulit na Bayad', 'Save Recurring Payment': 'I-save ang Paulit-ulit na Bayad',
  'Add Subscription': 'Magdagdag ng Subscription', 'Edit Subscription': 'I-edit ang Subscription', 'Save Subscription': 'I-save ang Subscription',
  'Weekly': 'Lingguhan', 'Bi-weekly': 'Tuwing dalawang linggo', 'Monthly': 'Buwanan', 'Quarterly': 'Kada kwarter', 'Annual': 'Taunan',
  'Import Statements & Documents': 'Mag-import ng Statement at Dokumento', 'CSV Statement': 'CSV Statement', 'Receipts & Invoices': 'Mga Resibo at Invoice',
  'Google Drive Inbox Sync': 'Google Drive Inbox Sync', 'Erase All Finova Data': 'Burahin Lahat ng Finova Data',
  // Toasts & notifications
  'Transaction added': 'Naidagdag ang transaksyon', 'Transaction updated': 'Na-update ang transaksyon', 'Transaction deleted': 'Nabura ang transaksyon',
  'Duplicate transaction detected and skipped': 'May kaparehong transaksyon, nilaktawan', 'Language updated': 'Napalitan ang wika', 'Currency updated': 'Napalitan ang pera',
  'Goal saved': 'Na-save ang layunin', 'Goal deleted': 'Nabura ang layunin', 'Budget saved': 'Na-save ang badyet', 'Budget deleted': 'Nabura ang badyet',
  'Recurring payment saved': 'Na-save ang paulit-ulit na bayad', 'Subscription saved': 'Na-save ang subscription', 'Subscription removed': 'Naalis ang subscription',
  'Net Worth totals configured and saved': 'Na-save ang Net Worth', 'At least one Admin account is required': 'Kailangan ng kahit isang Admin account',
  'Username:': 'Username:', 'Password:': 'Password:', 'Security Code:': 'Security Code:', 'Enter Code:': 'Ilagay ang Code:', 'Login': 'Mag-login',
  'Password': 'Password', 'Incorrect password.': 'Maling password.', 'Incorrect security code.': 'Maling security code.', 'Refresh code': 'I-refresh ang code'
};

const FIL_PATTERNS = [
  [/^(\d+) income transactions?$/, m => `${m[1]} transaksyon ng kita`],
  [/^(\d+) expense transactions?$/, m => `${m[1]} transaksyon ng gastos`],
  [/^(\d+) transactions?$/, m => `${m[1]} transaksyon`],
  [/^(\d+) suggestions?$/, m => `${m[1]} mungkahi`],
  [/^(\d+) candidates?$/, m => `${m[1]} posible`],
  [/^(\d+) documents?$/, m => `${m[1]} dokumento`],
  [/^(\d+)% spent$/, m => `${m[1]}% nagastos`],
  [/^Net: (.+) saved$/, m => `Net: naipon ang ${m[1]}`],
  [/^(.+) to go$/, m => `${m[1]} na lang`],
  [/^(.+) left$/, m => `${m[1]} natitira`],
  [/^Over by (.+)$/, m => `Lampas ng ${m[1]}`],
  [/^Target: (.+)$/, m => `Target: ${m[1]}`],
  [/^(\d+)% of (.+)$/, m => `${m[1]}% ng ${m[2]}`],
  [/^Account "(.+)" created$/, m => `Nagawa ang account na "${m[1]}"`],
  [/^Added (.+) to goal$/, m => `Nadagdag ang ${m[1]} sa layunin`]
];

function trText(str) {
  if (prefs.lang === 'en') return str;
  const D = I18N[prefs.lang] || {};
  if (D[str]) return D[str];
  for (const [re, fn] of (prefs.lang === 'fil' ? FIL_PATTERNS : [])) {
    const m = str.match(re);
    if (m) return fn(m);
  }
  // "Label *" and "Label (symbol) *" forms
  const m = str.match(/^(.+?)(?: \(([^)]{1,5})\))?( \*)?$/);
  if (m && D[m[1]] && (m[2] || m[3])) return D[m[1]] + (m[2] ? ` (${m[2]})` : '') + (m[3] || '');
  return str;
}

const i18nText = new WeakMap();

function i18nApply() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentNode && /^(SCRIPT|STYLE|CANVAS)$/.test(n.parentNode.nodeName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach(n => {
    const rec = i18nText.get(n);
    const orig = rec && n.nodeValue === rec.tr ? rec.orig : n.nodeValue;
    const core = orig.trim();
    if (!core) return;
    const tr = orig.replace(core, () => trText(core));
    if (tr !== n.nodeValue) n.nodeValue = tr;
    i18nText.set(n, { orig, tr });
  });

  document.querySelectorAll('[placeholder],[title]').forEach(el => {
    ['placeholder', 'title'].forEach(attr => {
      if (!el.hasAttribute(attr)) return;
      const cur = el.getAttribute(attr);
      const origKey = 'i18nO' + attr, trKey = 'i18nT' + attr;
      const orig = el.dataset[trKey] === cur && el.dataset[origKey] !== undefined ? el.dataset[origKey] : cur;
      const tr = trText(orig);
      el.dataset[origKey] = orig;
      el.dataset[trKey] = tr;
      if (tr !== cur) el.setAttribute(attr, tr);
    });
  });
}

// =============================================================================
// Admin interface
// =============================================================================

function adminData() {
  const now = new Date(), ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  return accounts.list.filter(a => a.role !== 'admin').map(a => {
    let st = {};
    try { st = JSON.parse(localStorage.getItem(STORAGE_KEY + '_' + a.id)) || {}; } catch (e) {}
    const tx = st.transactions || [];
    const sum = t => tx.filter(x => x.type === t).reduce((n, x) => n + x.amount, 0);
    const monthSpend = {};
    tx.forEach(x => { if (x.type === 'expense' && x.date.slice(0, 7) === ym) monthSpend[x.category] = (monthSpend[x.category] || 0) + x.amount; });
    return { a, tx, budgets: st.budgets || [], income: sum('income'), spent: sum('expense'), monthSpend };
  });
}
function budgetStatus(spent, limit) {
  if (!limit) return '<span class="badge badge-neutral">No budget</span>';
  if (spent > limit) return '<span class="badge badge-danger">Over budget</span>';
  if (spent >= limit * 0.75) return '<span class="badge badge-orange">Warning</span>';
  return '<span class="badge badge-green">On track</span>';
}

Object.assign(FinovaApp.prototype, {

  // ---------- Admin ----------
  adminRefresh() { this.renderAdmin(this.activeTab); this.refreshIcons(); },
  adminToggle(id) {
    const a = accounts.list.find(x => x.id === id); if (!a) return;
    a.active = a.active === false;
    accounts.save(); showToast(`${a.name} ${a.active ? 'activated' : 'deactivated'}`, 'success'); this.adminRefresh();
  },
  adminDelete(id) {
    const a = accounts.list.find(x => x.id === id); if (!a || a.role === 'admin') return;
    if (!confirm(`Delete account "${a.name}" and all of its data? This cannot be undone.`)) return;
    accounts.list = accounts.list.filter(x => x.id !== id);
    localStorage.removeItem(STORAGE_KEY + '_' + id);
    accounts.save(); showToast('Account deleted', 'info'); this.adminRefresh();
  },
  adminTerminate(id) {
    const a = accounts.list.find(x => x.id === id); if (!a || a.role === 'admin') return;
    if (a.terminated) { showToast(`${a.name} is already terminated.`, 'error'); return; }
    if (!confirm(`TERMINATE account "${a.name}"?\n\nThis will permanently block their access. The account cannot be re-activated.`)) return;
    a.active = false;
    a.terminated = true;
    accounts.save();
    showToast(`${a.name}'s account has been terminated.`, 'error');
    this.adminRefresh();
  },
  adminRecover(id) {
    const a = accounts.list.find(x => x.id === id); if (!a || a.role === 'admin') return;
    if (!a.terminated) { showToast(`${a.name} is not terminated.`, 'error'); return; }
    if (!confirm(`Recover account "${a.name}"?\n\nThis will re-enable access. The account will be active again.`)) return;
    a.active = true;
    a.terminated = false;
    accounts.save();
    showToast(`${a.name}'s account recovered.`, 'success');
    this.adminRefresh();
    this.renderSettings();
  },
  adminEmail(id) {
    const a = id === 'me' ? accounts.get() : accounts.list.find(x => x.id === id); if (!a) return;
    const v = (prompt(`Gmail for ${a.name}:`, a.email || '') || '').trim();
    if (!v) return;
    if (!/^[^\s@]+@gmail\.com$/i.test(v)) return showToast('Enter a valid @gmail.com address', 'error');
    if (accounts.list.some(x => x.id !== a.id && (x.email || '').toLowerCase() === v.toLowerCase())) return showToast('Gmail already in use', 'error');
    a.email = v; accounts.save(); showToast('Gmail saved', 'success'); this.adminRefresh();
  },
  adminSet(key, val) { (this.adminState = this.adminState || {})[key] = val; this.adminRefresh(); },

  renderAdmin(tab) {
    const root = document.getElementById('adminRoot-' + tab);
    if (!root) return;
    const D = adminData(), st = this.adminState = this.adminState || {}, F = formatCurrency;
    const kpi = (label, val, icon, cls) => `<div class="card summary-card"><div class="card-head"><span class="card-label">${label}</span><span class="card-icon-badge ${cls}"><i data-lucide="${icon}"></i></span></div><div class="metric-value-wrap"><span class="metric-value">${val}</span></div></div>`;
    const empty = '<div class="card"><div class="empty-state-card"><i data-lucide="users"></i><h3>No registered users yet</h3><p>Users appear here after they create an account.</p></div></div>';
    const mkChart = (id, cfg) => {
      this.adminCharts = this.adminCharts || {};
      this.adminCharts[id]?.destroy();
      const c = document.getElementById(id);
      if (c && window.Chart) this.adminCharts[id] = new Chart(c, cfg);
    };
    const nAct = D.filter(u => u.a.active !== false).length;
    const allTx = D.flatMap(u => u.tx.map(t => ({ ...t, user: u.a.name })));
    let html = '';

    if (tab === 'admin-dashboard') {
      const income = D.reduce((n, u) => n + u.income, 0), spent = D.reduce((n, u) => n + u.spent, 0);
      html = `<div class="admin-kpis">${kpi('Registered users', D.length, 'users', 'violet')}${kpi('Active users', nAct, 'user-check', 'green')}${kpi('Inactive users', D.length - nAct, 'user-x', 'orange')}${kpi('Total budgets', D.reduce((n, u) => n + u.budgets.length, 0), 'piggy-bank', 'blue')}${kpi('Transactions recorded', allTx.length, 'arrow-left-right', 'violet')}${kpi('Income vs spending', `${F(income)} / ${F(spent)}`, 'trending-up', 'green')}</div>
      <div class="admin-two"><div class="card chart-card"><h3 class="chart-title">User status</h3><div class="chart-container"><canvas id="admStatus"></canvas></div></div>
      <div class="card chart-card"><h3 class="chart-title">Spending by category (all users)</h3><div class="chart-container"><canvas id="admCats"></canvas></div></div></div>
      <div class="card"><h3 class="section-title mb-3">Most active users</h3><div class="table-responsive"><table class="data-table"><thead><tr><th>User</th><th>Transactions</th><th>Income</th><th>Spending</th></tr></thead><tbody>${[...D].sort((a, b) => b.tx.length - a.tx.length).slice(0, 8).map(u => `<tr><td><strong>${escapeHTML(u.a.name)}</strong></td><td>${u.tx.length}</td><td class="text-green">${F(u.income)}</td><td class="text-orange">${F(u.spent)}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">No data yet</td></tr>'}</tbody></table></div></div>`;
      root.innerHTML = html;
      const cats = {}; allTx.filter(t => t.type === 'expense').forEach(t => { cats[t.category] = (cats[t.category] || 0) + t.amount; });
      mkChart('admStatus', { type: 'doughnut', data: { labels: ['Active', 'Inactive'], datasets: [{ data: [nAct, D.length - nAct], backgroundColor: ['#0a8159', '#cf4a1a'], borderColor: '#fff', borderWidth: 2 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { position: 'bottom' } } } });
      mkChart('admCats', { type: 'bar', data: { labels: Object.keys(cats), datasets: [{ data: Object.values(cats), backgroundColor: '#4338ca', borderRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } } } } });
    }

    if (tab === 'admin-users') {
      const f = st.userFilter || 'all';
      const rows = D.filter(u => f === 'all' || (f === 'active') === (u.a.active !== false));
      const fb = (k, l) => `<button class="period-btn ${f === k ? 'active' : ''}" onclick="app.adminSet('userFilter','${k}')">${l}</button>`;
      html = `<div class="admin-filters"><div class="period-selector">${fb('all', `All (${D.length})`)}${fb('active', `Active (${nAct})`)}${fb('inactive', `Inactive (${D.length - nAct})`)}</div><button class="btn btn-secondary btn-sm" onclick="app.adminEmail('me')"><i data-lucide="mail"></i> Set my Gmail</button></div>
      <div class="card"><div class="table-responsive"><table class="data-table"><thead><tr><th>User</th><th>Gmail</th><th>Type</th><th>Status</th><th>Transactions</th><th>Budgets</th><th class="text-center">Actions</th></tr></thead><tbody>${rows.map(u => { const on = u.a.active !== false && !u.a.terminated; const terminated = !!u.a.terminated; const isCloud = !!u.a.isCloud; return `<tr${terminated ? ' style="opacity:0.6"' : ''}><td><strong>${escapeHTML(u.a.name)}</strong></td><td>${escapeHTML(u.a.email || '—')}</td><td>${isCloud ? '<span class="badge badge-violet"><i data-lucide="cloud" style="width:11px;height:11px;vertical-align:-1px"></i> Cloud</span>' : '<span class="badge badge-neutral">Local</span>'}</td><td>${terminated ? '<span class="badge badge-danger">Terminated</span>' : on ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-orange">Inactive</span>'}</td><td>${u.tx.length}</td><td>${u.budgets.length}</td><td class="text-center"><div class="table-action-btns">${terminated ? '' : `<button class="btn btn-secondary btn-sm" onclick="app.adminToggle('${u.a.id}')">${on ? 'Deactivate' : 'Activate'}</button>`}<button class="btn-icon-sm" title="Edit Gmail" onclick="app.adminEmail('${u.a.id}')"><i data-lucide="mail"></i></button>${terminated ? '' : `<button class="btn btn-danger btn-sm" title="Terminate account" onclick="app.adminTerminate('${u.a.id}')"><i data-lucide="shield-off"></i> Terminate</button>`}<button class="btn-icon-sm delete" title="Delete account" onclick="app.adminDelete('${u.a.id}')"><i data-lucide="trash-2"></i></button></div></td></tr>`; }).join('') || '<tr><td colspan="7" class="text-muted">No users in this list</td></tr>'}</tbody></table></div></div>`;
      root.innerHTML = D.length ? html : empty;
    }

    if (tab === 'admin-budgets') {
      const lim = u => u.budgets.reduce((n, b) => n + b.limit, 0);
      const spentB = u => u.budgets.reduce((n, b) => n + (u.monthSpend[b.category] || 0), 0);
      const TL = D.reduce((n, u) => n + lim(u), 0), TS = D.reduce((n, u) => n + spentB(u), 0);
      html = `<div class="admin-kpis">${kpi('Users\' total income', F(D.reduce((n, u) => n + u.income, 0)), 'trending-up', 'green')}${kpi('Total budget limits', F(TL), 'piggy-bank', 'blue')}${kpi('Spent this month', F(TS), 'trending-down', 'orange')}</div>
      <div class="card mb-4"><h3 class="section-title mb-3">User income & budget status</h3><div class="table-responsive"><table class="data-table"><thead><tr><th>User</th><th>Income</th><th>Budgets</th><th>Limit</th><th>Spent (month)</th><th>Status</th></tr></thead><tbody>${D.map(u => `<tr><td><strong>${escapeHTML(u.a.name)}</strong></td><td class="text-green">${F(u.income)}</td><td>${u.budgets.length}</td><td>${F(lim(u))}</td><td>${F(spentB(u))}</td><td>${budgetStatus(spentB(u), lim(u))}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><h3 class="section-title mb-3">Budget summaries</h3><div class="table-responsive"><table class="data-table"><thead><tr><th>User</th><th>Category</th><th>Limit</th><th>Spent</th><th style="min-width:140px">Progress</th><th>Status</th></tr></thead><tbody>${D.flatMap(u => u.budgets.map(b => { const sp = u.monthSpend[b.category] || 0, p = Math.min(100, Math.round(sp / b.limit * 100)); return `<tr><td>${escapeHTML(u.a.name)}</td><td>${escapeHTML(b.category)}</td><td>${F(b.limit)}</td><td>${F(sp)}</td><td><div class="budget-progress-track" style="margin:0"><div class="budget-progress-fill ${p >= 100 ? 'danger' : p >= 75 ? 'warn' : 'safe'}" style="width:${p}%"></div></div></td><td>${budgetStatus(sp, b.limit)}</td></tr>`; })).join('') || '<tr><td colspan="6" class="text-muted">No budgets created yet</td></tr>'}</tbody></table></div></div>`;
      root.innerHTML = D.length ? html : empty;
    }

    if (tab === 'admin-transactions') {
      const fu = st.txUser || '', fc = st.txCat || '';
      const cats = [...new Set(allTx.map(t => t.category))].sort();
      const rows = allTx.filter(t => (!fu || t.user === fu) && (!fc || t.category === fc)).sort((a, b) => b.date.localeCompare(a.date));
      const byCat = {}; rows.forEach(t => { const c = byCat[t.category] = byCat[t.category] || { n: 0, total: 0, rc: 0 }; c.n++; c.total += t.amount; if (t.receipt) c.rc++; });
      const opt = (arr, cur) => arr.map(v => `<option ${v === cur ? 'selected' : ''}>${escapeHTML(v)}</option>`).join('');
      html = `<div class="admin-filters"><div class="select-wrapper"><select onchange="app.adminSet('txUser',this.value)"><option value="">All users</option>${opt(D.map(u => u.a.name), fu)}</select></div><div class="select-wrapper"><select onchange="app.adminSet('txCat',this.value)"><option value="">All categories</option>${opt(cats, fc)}</select></div><span class="text-muted">${rows.length} transactions</span></div>
      <div class="card mb-4"><h3 class="section-title mb-3">Transactions by category</h3><div class="table-responsive"><table class="data-table"><thead><tr><th>Category</th><th>Transactions</th><th>With receipt</th><th class="text-right">Total</th></tr></thead><tbody>${Object.entries(byCat).sort((a, b) => b[1].total - a[1].total).map(([k, c]) => `<tr><td><span class="badge badge-neutral">${escapeHTML(k)}</span></td><td>${c.n}</td><td>${c.rc}</td><td class="text-right">${F(c.total)}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">No transactions</td></tr>'}</tbody></table></div></div>
      <div class="card"><h3 class="section-title mb-3">All transactions</h3><div class="table-responsive"><table class="data-table"><thead><tr><th>Date</th><th>User</th><th>Merchant</th><th>Category</th><th>Receipt</th><th class="text-right">Amount</th></tr></thead><tbody>${rows.slice(0, 200).map(t => `<tr><td>${t.date}</td><td>${escapeHTML(t.user)}</td><td><strong>${escapeHTML(t.merchant)}</strong></td><td><span class="badge badge-neutral">${escapeHTML(t.category)}</span></td><td>${t.receipt ? '<span class="receipt-icon-badge" title="Receipt attached"><i data-lucide="receipt"></i></span>' : '<span class="text-muted">—</span>'}</td><td class="text-right tx-amount ${t.type === 'income' ? 'text-green' : ''}">${t.type === 'income' ? '+' : '-'}${F(t.amount)}</td></tr>`).join('') || '<tr><td colspan="6" class="text-muted">No transactions</td></tr>'}</tbody></table></div></div>`;
      root.innerHTML = D.length ? html : empty;
    }
    this.refreshIcons();
  }
});

// ---- Extra Filipino strings (auth screen, header, ticker) ----
Object.assign(FIL, {
  'Dashboard': 'Dashboard', 'Sign In': 'Mag-sign In', 'Create Account': 'Gumawa ng Account', 'Username': 'Username',
  'Account Name': 'Pangalan ng Account', 'Create & Sign In': 'Gumawa at Mag-sign In', 'or': 'o', 'Back': 'Bumalik',
  'Sign in to access your financial dashboard': 'Mag-sign in para makita ang iyong dashboard',
  'Create a new local financial profile': 'Gumawa ng bagong lokal na profile',
  'Switch Saved Accounts': 'Palitan ang Naka-save na Account', 'Already have an account?': 'May account ka na?',
  'Switch Account': 'Palitan ang Account', 'Net Worth': 'Net Worth', 'Total Assets': 'Kabuuang Assets', 'Total Liabilities': 'Kabuuang Liabilities',
  'Demo Data': 'Sample na Data', 'Drive sync': 'Drive sync', 'Refresh': 'I-refresh', 'Live': 'Live',
  'REAL-TIME FOREX & MARKET RATES': 'REAL-TIME NA PALITAN NG PERA', 'Merchant or Source': 'Merchant o Pinagmulan',
  'Admin Dashboard': 'Admin Dashboard', 'User Management': 'Pamamahala ng User', 'Budget Management': 'Pamamahala ng Badyet', 'All Transactions': 'Lahat ng Transaksyon'
});

// ---- Spanish (main screens). Missing strings fall back to English. ----
const ES = {
  'Dashboard': 'Panel', 'Transactions': 'Transacciones', 'Recurring': 'Recurrentes', 'Subscriptions': 'Suscripciones', 'Budgets': 'Presupuestos',
  'Goals': 'Metas', 'Documents': 'Documentos', 'Settings': 'Ajustes', 'Private Finance': 'Finanzas privadas', 'Switch': 'Cambiar',
  'Total Income': 'Ingresos totales', 'Import': 'Importar', 'Add entry': 'Añadir', 'Demo Data': 'Datos de ejemplo', 'Drive sync': 'Sincronizar Drive',
  'Admin Dashboard': 'Panel de administración', 'User Management': 'Gestión de usuarios', 'Budget Management': 'Gestión de presupuestos', 'All Transactions': 'Todas las transacciones',
  'Refresh': 'Actualizar', 'Sign In': 'Iniciar sesión', 'Create Account': 'Crear cuenta', 'Username': 'Usuario', 'Password': 'Contraseña',
  'Account Name': 'Nombre de la cuenta', 'Create & Sign In': 'Crear e iniciar sesión', 'or': 'o', 'Back': 'Atrás',
  'Sign in to access your financial dashboard': 'Inicia sesión para ver tu panel financiero',
  'Create a new local financial profile': 'Crea un nuevo perfil financiero local', 'Switch Saved Accounts': 'Cambiar de cuenta guardada',
  'Already have an account?': '¿Ya tienes una cuenta?', 'Switch Account': 'Cambiar de cuenta', 'Loading Finova...': 'Cargando Finova...',
  'Personal financial overview': 'Resumen financiero personal', 'All recorded expenses and income': 'Todos los gastos e ingresos',
  'Recurring Payments': 'Pagos recurrentes', 'Savings Goals': 'Metas de ahorro', 'Documents Vault': 'Bóveda de documentos',
  'Date Period:': 'Periodo:', 'All time': 'Todo el tiempo', 'This week': 'Esta semana', 'This month': 'Este mes', 'This year': 'Este año',
  'Net Worth': 'Patrimonio neto', 'Assets minus liabilities': 'Activos menos pasivos', 'Configure in Settings': 'Configurar en Ajustes',
  'Total Spending': 'Gastos totales', 'Savings Rate': 'Tasa de ahorro', 'Cash Flow': 'Flujo de caja', 'Income': 'Ingresos', 'Spending': 'Gastos',
  'Spending by Category': 'Gasto por categoría', 'Recent Activity': 'Actividad reciente', 'View all': 'Ver todo', 'Coming Up': 'Próximos pagos',
  'Manage': 'Gestionar', 'Add transaction': 'Añadir transacción', 'Search merchant or category...': 'Buscar comercio o categoría...',
  'All Categories': 'Todas las categorías', 'All Accounts': 'Todas las cuentas', 'Reset': 'Restablecer', 'Date & Merchant': 'Fecha y comercio',
  'Category': 'Categoría', 'Account': 'Cuenta', 'Receipt': 'Recibo', 'Amount': 'Importe', 'Actions': 'Acciones',
  'No transactions found': 'No se encontraron transacciones', 'Import CSV': 'Importar CSV', 'Name': 'Nombre', 'Status': 'Estado',
  'Active': 'Activo', 'Paused': 'En pausa', 'Ignore': 'Ignorar', 'Keep': 'Conservar', 'Confirm': 'Confirmar', 'Cadence': 'Frecuencia',
  'Monthly Budget Health': 'Estado del presupuesto mensual', 'Create budget': 'Crear presupuesto', 'Total Budget': 'Presupuesto total',
  'Total Spent': 'Total gastado', 'Remaining': 'Restante', 'Create goal': 'Crear meta', 'Savings & Financial Goals': 'Metas de ahorro y finanzas',
  'Set a goal': 'Fijar una meta', 'Edit': 'Editar', 'Upload Documents': 'Subir documentos', 'Secure Document Vault': 'Bóveda segura de documentos',
  'Preferences': 'Preferencias', 'Language': 'Idioma', 'Currency': 'Moneda', 'Net Worth Configuration': 'Configuración del patrimonio',
  'Save Net Worth': 'Guardar patrimonio', 'Managed Categories': 'Categorías', 'Managed Accounts': 'Cuentas', 'Add': 'Añadir',
  'Danger Zone': 'Zona de peligro', 'Wipe All Data': 'Borrar todos los datos', 'Add Transaction': 'Añadir transacción',
  'Edit Transaction': 'Editar transacción', 'Expense': 'Gasto', 'Date': 'Fecha', 'Save Transaction': 'Guardar transacción',
  'Merchant or Source': 'Comercio u origen', 'Total Assets': 'Activos totales', 'Total Liabilities': 'Pasivos totales',
  'Cancel': 'Cancelar', 'Close': 'Cerrar', 'Done': 'Hecho', 'Weekly': 'Semanal', 'Bi-weekly': 'Quincenal', 'Monthly': 'Mensual',
  'Quarterly': 'Trimestral', 'Annual': 'Anual', 'Language updated': 'Idioma actualizado', 'Currency updated': 'Moneda actualizada',
  'Transaction added': 'Transacción añadida', 'Transaction updated': 'Transacción actualizada', 'Transaction deleted': 'Transacción eliminada',
  'Goal saved': 'Meta guardada', 'Budget saved': 'Presupuesto guardado', 'Incorrect password.': 'Contraseña incorrecta.'
};

// ---- More languages (core UI: menus, sign-in, dashboard labels, main buttons). Missing text stays English. ----
const KEYS = ['Dashboard','Transactions','Recurring','Subscriptions','Budgets','Goals','Documents','Settings','Admin Dashboard','User Management','Budget Management','All Transactions','Sign In','Create Account','Gmail or username','Password','Total Income','Total Spending','Net Worth','Savings Rate','Cash Flow','Income','Spending','Spending by Category','Recent Activity','View all','Add entry','Import','Cancel','Close','Language','Currency','Preferences','Add transaction','Save Transaction','Category','Account','Amount','Date','Status','Actions','Active','All time','This week','This month','This year','Date Period:','Add Transaction','Expense','Reset','Switch','Done','Registered users','Active users','Inactive users','Total budgets','Activate','Deactivate','Gmail','Remaining','Inactive'];
const pack = a => Object.fromEntries(KEYS.map((k, i) => [k, a[i]]));
const FR = pack(['Tableau de bord','Transactions','Récurrents','Abonnements','Budgets','Objectifs','Documents','Paramètres','Tableau de bord admin','Gestion des utilisateurs','Gestion des budgets','Toutes les transactions','Se connecter','Créer un compte',"Gmail ou nom d'utilisateur",'Mot de passe','Revenus totaux','Dépenses totales','Patrimoine net',"Taux d'épargne",'Flux de trésorerie','Revenus','Dépenses','Dépenses par catégorie','Activité récente','Tout voir','Ajouter','Importer','Annuler','Fermer','Langue','Devise','Préférences','Ajouter une transaction','Enregistrer la transaction','Catégorie','Compte','Montant','Date','Statut','Actions','Actif','Depuis toujours','Cette semaine','Ce mois-ci','Cette année','Période :','Ajouter une transaction','Dépense','Réinitialiser','Changer','Terminé','Utilisateurs inscrits','Utilisateurs actifs','Utilisateurs inactifs','Total des budgets','Activer','Désactiver','Gmail','Restant','Inactif']);
const DE = pack(['Übersicht','Transaktionen','Wiederkehrend','Abos','Budgets','Ziele','Dokumente','Einstellungen','Admin-Übersicht','Benutzerverwaltung','Budgetverwaltung','Alle Transaktionen','Anmelden','Konto erstellen','Gmail oder Benutzername','Passwort','Gesamteinnahmen','Gesamtausgaben','Nettovermögen','Sparquote','Cashflow','Einnahmen','Ausgaben','Ausgaben nach Kategorie','Letzte Aktivität','Alle anzeigen','Hinzufügen','Importieren','Abbrechen','Schließen','Sprache','Währung','Präferenzen','Transaktion hinzufügen','Transaktion speichern','Kategorie','Konto','Betrag','Datum','Status','Aktionen','Aktiv','Gesamte Zeit','Diese Woche','Dieser Monat','Dieses Jahr','Zeitraum:','Transaktion hinzufügen','Ausgabe','Zurücksetzen','Wechseln','Fertig','Registrierte Benutzer','Aktive Benutzer','Inaktive Benutzer','Budgets gesamt','Aktivieren','Deaktivieren','Gmail','Verbleibend','Inaktiv']);
const JA = pack(['ダッシュボード','取引','定期支払い','サブスクリプション','予算','目標','書類','設定','管理ダッシュボード','ユーザー管理','予算管理','すべての取引','ログイン','アカウント作成','Gmail またはユーザー名','パスワード','総収入','総支出','純資産','貯蓄率','キャッシュフロー','収入','支出','カテゴリ別支出','最近の活動','すべて表示','追加','インポート','キャンセル','閉じる','言語','通貨','環境設定','取引を追加','取引を保存','カテゴリ','口座','金額','日付','ステータス','操作','有効','全期間','今週','今月','今年','期間:','取引を追加','支出','リセット','切り替え','完了','登録ユーザー','有効なユーザー','無効なユーザー','予算合計','有効化','無効化','Gmail','残り','無効']);
const KO = pack(['대시보드','거래','정기 결제','구독','예산','목표','문서','설정','관리자 대시보드','사용자 관리','예산 관리','전체 거래','로그인','계정 만들기','Gmail 또는 사용자 이름','비밀번호','총 수입','총 지출','순자산','저축률','현금 흐름','수입','지출','카테고리별 지출','최근 활동','모두 보기','추가','가져오기','취소','닫기','언어','통화','환경설정','거래 추가','거래 저장','카테고리','계좌','금액','날짜','상태','작업','활성','전체 기간','이번 주','이번 달','올해','기간:','거래 추가','지출','초기화','전환','완료','가입 사용자','활성 사용자','비활성 사용자','전체 예산','활성화','비활성화','Gmail','남음','비활성']);
const ZH = pack(['仪表盘','交易','定期付款','订阅','预算','目标','文档','设置','管理员仪表盘','用户管理','预算管理','全部交易','登录','创建账户','Gmail 或用户名','密码','总收入','总支出','净资产','储蓄率','现金流','收入','支出','按类别支出','最近活动','查看全部','添加','导入','取消','关闭','语言','货币','偏好设置','添加交易','保存交易','类别','账户','金额','日期','状态','操作','启用','全部时间','本周','本月','今年','日期范围:','添加交易','支出','重置','切换','完成','注册用户','活跃用户','停用用户','预算总数','启用','停用','Gmail','剩余','已停用']);
[8, 9, 10, 11, 14, 52, 53, 54, 55, 56, 57, 58, 60].forEach((k, j) => {
  ES[KEYS[k]] = ['Panel de administración','Gestión de usuarios','Gestión de presupuestos','Todas las transacciones','Gmail o usuario','Usuarios registrados','Usuarios activos','Usuarios inactivos','Total de presupuestos','Activar','Desactivar','Gmail','Inactivo'][j];
});

const LANG_META = {
  en:  { label: 'English',    locale: 'en-US' },
  fil: { label: 'Filipino',   locale: 'fil-PH' },
  es:  { label: 'Español',    locale: 'es-ES' },
  fr:  { label: 'Français',   locale: 'fr-FR' },
  de:  { label: 'Deutsch',    locale: 'de-DE' },
  ja:  { label: '日本語',      locale: 'ja-JP' },
  ko:  { label: '한국어',      locale: 'ko-KR' },
  zh:  { label: '中文（简体）', locale: 'zh-CN' }
};
const I18N = { fil: FIL, es: ES, fr: FR, de: DE, ja: JA, ko: KO, zh: ZH };
if (!LANG_META[prefs.lang]) prefs.lang = 'en';

// Instantiate App on DOM ready
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new FinovaApp();
  app.boot();
});


// =============================================================================
// FINOVA AI CHATBOT
// =============================================================================
(function () {
  'use strict';

  // ── UI helpers ───────────────────────────────────────────────────────────────
  function addMsg(text, who) {
    const msgs = document.getElementById('chatbotMessages');
    if (!msgs) return;
    const el = document.createElement('div');
    el.className = 'chatbot-msg ' + who;
    el.innerHTML = `<div class="chatbot-bubble">${text}</div>`;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return el;
  }

  function addTyping() {
    const msgs = document.getElementById('chatbotMessages');
    if (!msgs) return null;
    const el = document.createElement('div');
    el.className = 'chatbot-msg bot chatbot-typing';
    el.innerHTML = '<div class="chatbot-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  // ── Finance brain ─────────────────────────────────────────────────────────────
  function getState() {
    try {
      // Data is stored per account: <STORAGE_KEY>_<accountId>
      return JSON.parse(localStorage.getItem(store.key || STORAGE_KEY)) || {};
    } catch (_) { return {}; }
  }

  function fmt(n) {
    return formatCurrency(Number(n) || 0);
  }

  function respond(raw) {
    const q = raw.toLowerCase().trim();
    const s = getState();
    const txs  = s.transactions || [];
    const buds = s.budgets || [];
    const goals = s.goals || [];
    const recs  = s.recurring || [];
    const subs  = s.subscriptions || [];

    // ── Total spending / income ─────────────────────────────────────────────────
    if (/spend|total expense|how much.*spent/.test(q)) {
      const total = txs.filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount), 0);
      return `💸 Your total spending is <strong>${fmt(total)}</strong> across <strong>${txs.filter(t=>t.type==='expense').length}</strong> transactions.`;
    }
    if (/income|earn|salary|revenue/.test(q)) {
      const total = txs.filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount), 0);
      return `💰 Your total income is <strong>${fmt(total)}</strong>.`;
    }
    if (/balance|net worth|cash flow/.test(q)) {
      const inc = txs.filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount), 0);
      const exp = txs.filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount), 0);
      const net = inc - exp;
      return `📊 Income: <strong>${fmt(inc)}</strong> | Expenses: <strong>${fmt(exp)}</strong> | Net: <strong style="color:${net>=0?'#0a8159':'#cf4a1a'}">${fmt(net)}</strong>`;
    }

    // ── Categories ──────────────────────────────────────────────────────────────
    if (/categor|top spend|breakdown/.test(q)) {
      const exp = txs.filter(t => t.type === 'expense');
      if (!exp.length) return '📊 No expense transactions yet.';
      const map = {};
      exp.forEach(t => { map[t.category || 'Other'] = (map[t.category || 'Other'] || 0) + Number(t.amount); });
      const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
      return '📊 <strong>Top spending categories:</strong><br>' +
        sorted.map((c, i) => `${i+1}. ${c[0]} — <strong>${fmt(c[1])}</strong>`).join('<br>');
    }

    // ── Budgets ─────────────────────────────────────────────────────────────────
    if (/budget/.test(q)) {
      if (!buds.length) return '🎯 No budgets set up yet. Go to Budgets to create one!';
      const now = new Date();
      const mo = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      const rows = buds.map(b => {
        const spent = txs.filter(t => t.type==='expense' && t.category===b.category && (t.date||'').startsWith(mo))
          .reduce((a,t) => a + Number(t.amount), 0);
        const pct = Math.min(100, Math.round(spent / b.limit * 100));
        const icon = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
        return `${icon} <strong>${b.category}</strong>: ${fmt(spent)} / ${fmt(b.limit)} (${pct}%)`;
      });
      return '🎯 <strong>Budget status this month:</strong><br>' + rows.join('<br>');
    }

    // ── Goals ───────────────────────────────────────────────────────────────────
    if (/goal|saving|target/.test(q)) {
      if (!goals.length) return '🏆 No goals set yet. Add one in the Goals section!';
      const rows = goals.map(g => {
        const pct = Math.min(100, Math.round((g.current / g.target) * 100));
        return `🏆 <strong>${g.name}</strong>: ${fmt(g.current)} / ${fmt(g.target)} (${pct}%)`;
      });
      return rows.join('<br>');
    }

    // ── Recent transactions ──────────────────────────────────────────────────────
    if (/recent|last|latest|transaction/.test(q)) {
      const recent = [...txs].sort((a,b) => (b.date||'').localeCompare(a.date||'')).slice(0, 5);
      if (!recent.length) return '📋 No transactions recorded yet.';
      return '📋 <strong>Last 5 transactions:</strong><br>' +
        recent.map(t => `${t.type==='income'?'💰':'💸'} ${t.merchant} — <strong>${fmt(t.amount)}</strong> (${t.date||'—'})`).join('<br>');
    }

    // ── Subscriptions ────────────────────────────────────────────────────────────
    if (/subscri|netflix|spotify|membership/.test(q)) {
      if (!subs.length) return '📺 No subscriptions tracked yet.';
      const total = subs.reduce((a,s) => a + Number(s.amount), 0);
      return `📺 You have <strong>${subs.length}</strong> subscriptions totalling <strong>${fmt(total)}/mo</strong>:<br>` +
        subs.map(s => `• ${s.name} — ${fmt(s.amount)}`).join('<br>');
    }

    // ── Recurring ────────────────────────────────────────────────────────────────
    if (/recurr|bill|rent|mortgage/.test(q)) {
      if (!recs.length) return '🔁 No recurring payments tracked yet.';
      const total = recs.reduce((a,r) => a + Number(r.amount), 0);
      return `🔁 <strong>${recs.length}</strong> recurring payments totalling <strong>${fmt(total)}/mo</strong>:<br>` +
        recs.map(r => `• ${r.name} — ${fmt(r.amount)}`).join('<br>');
    }

    // ── Advice / tips ────────────────────────────────────────────────────────────
    if (/tip|advice|suggest|help me|how to save/.test(q)) {
      const inc = txs.filter(t=>t.type==='income').reduce((a,t)=>a+Number(t.amount),0);
      const exp = txs.filter(t=>t.type==='expense').reduce((a,t)=>a+Number(t.amount),0);
      const rate = inc > 0 ? Math.round((inc-exp)/inc*100) : 0;
      return `💡 <strong>Financial tips for you:</strong><br>
• Your current savings rate is <strong>${rate}%</strong> ${rate >= 20 ? '✅ Great!' : '⚠️ Aim for 20%+'}<br>
• Review subscriptions regularly to cut unused ones<br>
• Set a budget for your top spending category<br>
• Keep 3–6 months of expenses as an emergency fund`;
    }

    // ── Greetings ────────────────────────────────────────────────────────────────
    if (/^(hi|hello|hey|yo|sup)/.test(q)) {
      return `👋 Hello! I'm Finova AI. Ask me about your spending, income, budgets, goals, or subscriptions!`;
    }

    // ── Default ──────────────────────────────────────────────────────────────────
    return `🤔 I can help with:<br>
<span class="chatbot-suggestion" onclick="chatbotAsk('What is my total spending?')">💸 Spending</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('Show my income')">💰 Income</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('Show my top categories')">📊 Categories</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('How are my budgets?')">🎯 Budgets</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('Show my goals')">🏆 Goals</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('Give me financial tips')">💡 Tips</span>`;
  }

  // ── Public ask function (called from HTML onclick) ────────────────────────────
  window.chatbotAsk = function (text) {
    if (!text.trim()) return;
    const input = document.getElementById('chatbotInput');
    addMsg(text, 'user');
    if (input) input.value = '';
    const typing = addTyping();
    setTimeout(() => {
      if (typing) typing.remove();
      addMsg(respond(text), 'bot');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 600);
  };

  // ── Init on DOM ready ────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const wrap   = document.getElementById('chatbotWrap');
    const toggle = document.getElementById('chatbotToggle');
    const close  = document.getElementById('chatbotClose');
    const input  = document.getElementById('chatbotInput');
    const send   = document.getElementById('chatbotSend');

    if (!wrap || !toggle) return;

    toggle.addEventListener('click', () => wrap.classList.toggle('open'));
    if (close) close.addEventListener('click', () => wrap.classList.remove('open'));

    function submit() {
      const val = (input?.value || '').trim();
      if (!val) return;
      window.chatbotAsk(val);
    }

    if (send) send.addEventListener('click', submit);
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  });
})();


// =============================================================================
// FINOVA AI CHATBOT — duplicate block disabled (single implementation above)
// Registering it twice bound #chatbotToggle twice, so one click toggled the
// panel open and immediately closed it again.
// =============================================================================
(function () {
  'use strict';
  return;

  // ── UI helpers ───────────────────────────────────────────────────────────────
  function addMsg(text, who) {
    const msgs = document.getElementById('chatbotMessages');
    if (!msgs) return;
    const el = document.createElement('div');
    el.className = 'chatbot-msg ' + who;
    el.innerHTML = `<div class="chatbot-bubble">${text}</div>`;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    return el;
  }

  function addTyping() {
    const msgs = document.getElementById('chatbotMessages');
    if (!msgs) return null;
    const el = document.createElement('div');
    el.className = 'chatbot-msg bot chatbot-typing';
    el.innerHTML = '<div class="chatbot-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  // ── Finance brain ─────────────────────────────────────────────────────────────
  function getState() {
    try { return JSON.parse(localStorage.getItem('finova_private_finance_store')) || {}; } catch { return {}; }
  }

  function fmt(n) {
    const num = Number(n) || 0;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
  }

  function respond(raw) {
    const q = raw.toLowerCase().trim();
    const s = getState();
    const txs  = s.transactions || [];
    const buds = s.budgets || [];
    const goals = s.goals || [];
    const recs  = s.recurring || [];
    const subs  = s.subscriptions || [];

    // ── Total spending / income ─────────────────────────────────────────────────
    if (/spend|total expense|how much.*spent/.test(q)) {
      const total = txs.filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount), 0);
      return `💸 Your total spending is <strong>${fmt(total)}</strong> across <strong>${txs.filter(t=>t.type==='expense').length}</strong> transactions.`;
    }
    if (/income|earn|salary|revenue/.test(q)) {
      const total = txs.filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount), 0);
      return `💰 Your total income is <strong>${fmt(total)}</strong>.`;
    }
    if (/balance|net worth|cash flow/.test(q)) {
      const inc = txs.filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount), 0);
      const exp = txs.filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount), 0);
      const net = inc - exp;
      return `📊 Income: <strong>${fmt(inc)}</strong> | Expenses: <strong>${fmt(exp)}</strong> | Net: <strong style="color:${net>=0?'#0a8159':'#cf4a1a'}">${fmt(net)}</strong>`;
    }

    // ── Categories ──────────────────────────────────────────────────────────────
    if (/categor|top spend|breakdown/.test(q)) {
      const exp = txs.filter(t => t.type === 'expense');
      if (!exp.length) return '📊 No expense transactions yet.';
      const map = {};
      exp.forEach(t => { map[t.category || 'Other'] = (map[t.category || 'Other'] || 0) + Number(t.amount); });
      const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
      return '📊 <strong>Top spending categories:</strong><br>' +
        sorted.map((c, i) => `${i+1}. ${c[0]} — <strong>${fmt(c[1])}</strong>`).join('<br>');
    }

    // ── Budgets ─────────────────────────────────────────────────────────────────
    if (/budget/.test(q)) {
      if (!buds.length) return '🎯 No budgets set up yet. Go to Budgets to create one!';
      const now = new Date();
      const mo = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      const rows = buds.map(b => {
        const spent = txs.filter(t => t.type==='expense' && t.category===b.category && (t.date||'').startsWith(mo))
          .reduce((a,t) => a + Number(t.amount), 0);
        const pct = Math.min(100, Math.round(spent / b.limit * 100));
        const icon = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
        return `${icon} <strong>${b.category}</strong>: ${fmt(spent)} / ${fmt(b.limit)} (${pct}%)`;
      });
      return '🎯 <strong>Budget status this month:</strong><br>' + rows.join('<br>');
    }

    // ── Goals ───────────────────────────────────────────────────────────────────
    if (/goal|saving|target/.test(q)) {
      if (!goals.length) return '🏆 No goals set yet. Add one in the Goals section!';
      const rows = goals.map(g => {
        const pct = Math.min(100, Math.round((g.current / g.target) * 100));
        return `🏆 <strong>${g.name}</strong>: ${fmt(g.current)} / ${fmt(g.target)} (${pct}%)`;
      });
      return rows.join('<br>');
    }

    // ── Recent transactions ──────────────────────────────────────────────────────
    if (/recent|last|latest|transaction/.test(q)) {
      const recent = [...txs].sort((a,b) => (b.date||'').localeCompare(a.date||'')).slice(0, 5);
      if (!recent.length) return '📋 No transactions recorded yet.';
      return '📋 <strong>Last 5 transactions:</strong><br>' +
        recent.map(t => `${t.type==='income'?'💰':'💸'} ${t.merchant} — <strong>${fmt(t.amount)}</strong> (${t.date||'—'})`).join('<br>');
    }

    // ── Subscriptions ────────────────────────────────────────────────────────────
    if (/subscri|netflix|spotify|membership/.test(q)) {
      if (!subs.length) return '📺 No subscriptions tracked yet.';
      const total = subs.reduce((a,s) => a + Number(s.amount), 0);
      return `📺 You have <strong>${subs.length}</strong> subscriptions totalling <strong>${fmt(total)}/mo</strong>:<br>` +
        subs.map(s => `• ${s.name} — ${fmt(s.amount)}`).join('<br>');
    }

    // ── Recurring ────────────────────────────────────────────────────────────────
    if (/recurr|bill|rent|mortgage/.test(q)) {
      if (!recs.length) return '🔁 No recurring payments tracked yet.';
      const total = recs.reduce((a,r) => a + Number(r.amount), 0);
      return `🔁 <strong>${recs.length}</strong> recurring payments totalling <strong>${fmt(total)}/mo</strong>:<br>` +
        recs.map(r => `• ${r.name} — ${fmt(r.amount)}`).join('<br>');
    }

    // ── Advice / tips ────────────────────────────────────────────────────────────
    if (/tip|advice|suggest|help me|how to save/.test(q)) {
      const inc = txs.filter(t=>t.type==='income').reduce((a,t)=>a+Number(t.amount),0);
      const exp = txs.filter(t=>t.type==='expense').reduce((a,t)=>a+Number(t.amount),0);
      const rate = inc > 0 ? Math.round((inc-exp)/inc*100) : 0;
      return `💡 <strong>Financial tips for you:</strong><br>
• Your current savings rate is <strong>${rate}%</strong> ${rate >= 20 ? '✅ Great!' : '⚠️ Aim for 20%+'}<br>
• Review subscriptions regularly to cut unused ones<br>
• Set a budget for your top spending category<br>
• Keep 3–6 months of expenses as an emergency fund`;
    }

    // ── Greetings ────────────────────────────────────────────────────────────────
    if (/^(hi|hello|hey|yo|sup)/.test(q)) {
      return `👋 Hello! I'm Finova AI. Ask me about your spending, income, budgets, goals, or subscriptions!`;
    }

    // ── Default ──────────────────────────────────────────────────────────────────
    return `🤔 I can help with:<br>
<span class="chatbot-suggestion" onclick="chatbotAsk('What is my total spending?')">💸 Spending</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('Show my income')">💰 Income</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('Show my top categories')">📊 Categories</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('How are my budgets?')">🎯 Budgets</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('Show my goals')">🏆 Goals</span>
<span class="chatbot-suggestion" onclick="chatbotAsk('Give me financial tips')">💡 Tips</span>`;
  }

  // ── Public ask function (called from HTML onclick) ────────────────────────────
  window.chatbotAsk = function (text) {
    if (!text.trim()) return;
    const input = document.getElementById('chatbotInput');
    addMsg(text, 'user');
    if (input) input.value = '';
    const typing = addTyping();
    setTimeout(() => {
      if (typing) typing.remove();
      addMsg(respond(text), 'bot');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 600);
  };

  // ── Init on DOM ready ────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const wrap   = document.getElementById('chatbotWrap');
    const toggle = document.getElementById('chatbotToggle');
    const close  = document.getElementById('chatbotClose');
    const input  = document.getElementById('chatbotInput');
    const send   = document.getElementById('chatbotSend');

    if (!wrap || !toggle) return;

    toggle.addEventListener('click', () => wrap.classList.toggle('open'));
    if (close) close.addEventListener('click', () => wrap.classList.remove('open'));

    function submit() {
      const val = (input?.value || '').trim();
      if (!val) return;
      window.chatbotAsk(val);
    }

    if (send) send.addEventListener('click', submit);
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  });
})();

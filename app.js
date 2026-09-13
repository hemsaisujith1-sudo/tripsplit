/* =========================================================
   CONSTANTS & CONFIG
========================================================= */

const STORAGE_KEY_ONGOING = 'tripsplit_ongoing_trips';
const STORAGE_KEY_PAST = 'tripsplit_past_trips';
const STORAGE_KEY_DRAFT = 'tripsplit_new_trip_draft';
const STORAGE_KEY_AUTH = 'tripsplit_auth';
const API_BASE = '/api/trips';

let BACKEND_ONLINE = null;
const SYNC_DEBOUNCE_MS = 400;

const CURRENCIES = [
    { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
    { code: 'USD', symbol: '$', name: 'US Dollar' },
    { code: 'EUR', symbol: '€', name: 'Euro' },
    { code: 'GBP', symbol: '£', name: 'British Pound' },
    { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
    { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
    { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
    { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' }
];

/* =========================================================
   GLOBAL STATE (rehydrated on every page load from
   localStorage + URL query params; never survives across
   page reloads as the source of truth)
========================================================= */

let memberCount = 4;
let ongoingTripsData = [];
let pastTripsData = [];
let currentTripIndex = null;
let currentMemberIndex = null;
let viewingPastTripIndex = null;
let editingTripIndex = null;
let editingExpenseIndex = null;
let customSplitMode = false;
let selectedSplitMemberIndices = [];
let syncTimeout = null;

/* =========================================================
   PAGE META
========================================================= */

const PAGES = {
    landing:      { id: 'landing',      navActive: null,     name: 'TripSplit' },
    home:         { id: 'home',         navActive: 'home',   name: 'Home' },
    newTrip:      { id: 'newTrip',      navActive: 'home',   name: 'New Trip' },
    memberNames:  { id: 'memberNames',  navActive: 'home',   name: 'Trip Members' },
    dashboard:    { id: 'dashboard',    navActive: 'ongoing',name: 'Trip Dashboard' },
    ongoing:      { id: 'ongoing',      navActive: 'ongoing',name: 'Ongoing Trips' },
    past:         { id: 'past',         navActive: 'past',   name: 'Past Trips' },
    tripMembers:  { id: 'tripMembers',  navActive: 'ongoing',name: 'Trip Members' },
    expense:      { id: 'expense',      navActive: 'ongoing',name: 'Add Expense' },
    summary:      { id: 'summary',      navActive: 'ongoing',name: 'Trip Summary' },
    notFound:     { id: 'notFound',     navActive: null,     name: '404' }
};

/* =========================================================
   QUERY STRING HELPERS
========================================================= */

function getQuery() {
    const params = new URLSearchParams(window.location.search);
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
}

function buildQuery(obj) {
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (entries.length === 0) return '';
    return '?' + new URLSearchParams(entries).toString();
}

function navigate(path, queryObj) {
    window.location.assign(path + buildQuery(queryObj || {}));
}

function getAuth() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_AUTH) || 'null'); } catch (e) { return null; }
}

function saveAuth(data) {
    localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(data));
}

function clearAuth() {
    localStorage.removeItem(STORAGE_KEY_AUTH);
}

async function authRequest(path, body) {
    const res = await fetch('/api/auth' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Authentication failed');
    return data;
}

/* =========================================================
   DRAFT TRIP (used between new-trip.html → member-names.html)
========================================================= */

function saveDraftTrip(t) {
    localStorage.setItem(STORAGE_KEY_DRAFT, JSON.stringify(t));
}
function loadDraftTrip() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_DRAFT);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}
function clearDraftTrip() {
    localStorage.removeItem(STORAGE_KEY_DRAFT);
}

/* =========================================================
   LOCAL STORAGE (arrays)
========================================================= */

function loadFromStorage() {
    try {
        const ongoing = localStorage.getItem(STORAGE_KEY_ONGOING);
        const past = localStorage.getItem(STORAGE_KEY_PAST);
        if (ongoing) ongoingTripsData = JSON.parse(ongoing);
        if (past) pastTripsData = JSON.parse(past);
    } catch (e) {
        console.warn('Failed to load from storage', e);
        ongoingTripsData = [];
        pastTripsData = [];
    }
}

function saveToStorage() {
    try {
        localStorage.setItem(STORAGE_KEY_ONGOING, JSON.stringify(ongoingTripsData));
        localStorage.setItem(STORAGE_KEY_PAST, JSON.stringify(pastTripsData));
    } catch (e) {
        console.warn('Failed to save to storage', e);
    }
}

/* =========================================================
   TRIP LOCAL ID LOOKUP
========================================================= */

function ensureLocalIds() {
    for (const arr of [ongoingTripsData, pastTripsData]) {
        for (const trip of arr) {
            if (!trip.localId) {
                trip.localId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : 'trip-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
            }
            (trip.members || []).forEach(m => {
                if (!Array.isArray(m.expenses)) m.expenses = [];
            });
        }
    }
    saveToStorage();
}

function findTripByLocalId(localId) {
    for (let i = 0; i < ongoingTripsData.length; i++) {
        if (ongoingTripsData[i].localId === localId) {
            return { trip: ongoingTripsData[i], array: ongoingTripsData, index: i, isPast: false };
        }
    }
    for (let i = 0; i < pastTripsData.length; i++) {
        if (pastTripsData[i].localId === localId) {
            return { trip: pastTripsData[i], array: pastTripsData, index: i, isPast: true };
        }
    }
    return null;
}

/* =========================================================
   API HELPERS (graceful offline fallback)
========================================================= */

async function api(method, path, body) {
    if (BACKEND_ONLINE === false && method !== 'GET') return null;

    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    const auth = getAuth();
    if (auth && auth.token) opts.headers.Authorization = `Bearer ${auth.token}`;
    if (body !== undefined) opts.body = JSON.stringify(body);

    try {
        const res = await fetch(API_BASE + path, opts);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        BACKEND_ONLINE = true;
        return await res.json().catch(() => null);
    } catch (err) {
        if (method === 'GET' && BACKEND_ONLINE === null) {
            BACKEND_ONLINE = false;
        }
        return null;
    }
}

/* =========================================================
   FULL LOAD: API FIRST, FALLBACK TO STORAGE
========================================================= */

async function fullLoad() {
    loadFromStorage();

    const [ongoing, past] = await Promise.all([
        api('GET', '/ongoing'),
        api('GET', '/past')
    ]);

    if (ongoing && Array.isArray(ongoing)) ongoingTripsData = ongoing.map(enrichWithLocalIds);
    if (past && Array.isArray(past)) pastTripsData = past.map(enrichWithLocalIds);

    ensureLocalIds();
    saveToStorage();
}

function enrichWithLocalIds(t) {
    (t.members || []).forEach((m) => {
        if (!Array.isArray(m.expenses)) m.expenses = [];
    });
    return t;
}

/* =========================================================
   PERSIST HELPERS: SYNC TO BACKEND (debounced) + STORAGE
========================================================= */

function persistAll() {
    ensureLocalIds();
    saveToStorage();
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        try { syncTripsToBackend().catch(() => {}); } catch (e) {}
    }, SYNC_DEBOUNCE_MS);
}

async function syncTripsToBackend() {
    if (BACKEND_ONLINE === false) return;
    try {
        const [remoteOngoing, remotePast] = await Promise.all([
            api('GET', '/ongoing'),
            api('GET', '/past')
        ]);
        const remoteIds = new Set([
            ...(remoteOngoing || []).map((t) => String(t._id)),
            ...(remotePast || []).map((t) => String(t._id))
        ]);
        for (const trip of ongoingTripsData) {
            if (!trip._id) {
                const created = await api('POST', '/', stripInternal(trip));
                if (created && created._id) trip._id = created._id;
            } else if (!remoteIds.has(String(trip._id))) {
                const created = await api('POST', '/', stripInternal(trip));
                if (created && created._id) trip._id = created._id;
            } else {
                await api('PUT', `/${trip._id}`, stripInternal(trip));
            }
        }
        saveToStorage();
    } catch (e) {
        console.warn('Sync failed:', e);
    }
}

function stripInternal(t) {
    const copy = JSON.parse(JSON.stringify(t));
    delete copy._id;
    delete copy.__v;
    delete copy.createdAt;
    delete copy.updatedAt;
    delete copy.localId;
    if (copy.isCompleted) {
        delete copy.isCompleted;
        delete copy.completedDate;
    }
    return copy;
}

/* =========================================================
   SHARED CHROME: NAV + BREADCRUMB + TOAST ROOT
========================================================= */

function renderNav(activeKey) {
    const header = document.getElementById('global-header');
    if (!header) return;
    const linkOf = (key, href, label, hasBadge, badgeCount) => `
        <a class="nav-item ${activeKey === key ? 'nav-active' : ''}" href="${href}">
            <span>${label}</span>
            ${hasBadge ? `<span class="count-badge">${badgeCount ?? 0}</span>` : ''}
        </a>
    `;
    const ongoingCount = ongoingTripsData.length;
    const pastCount = pastTripsData.length;
    const auth = getAuth();
    header.innerHTML = `
        <nav class="global-nav">
            <div class="nav-container">
                <a class="nav-logo" href="home.html">TripSplit</a>
                <div class="nav-items">
                    ${linkOf('home', 'home.html', 'Home')}
                    ${linkOf('ongoing', 'ongoing.html', 'Ongoing', ongoingCount > 0, ongoingCount)}
                    ${linkOf('past', 'past.html', 'Past', pastCount > 0, pastCount)}
                    <a class="nav-account" href="${auth ? 'account.html' : 'login.html'}">${auth ? escapeHTML(auth.user.name) : 'Log in'}</a>
                    <a class="primary-btn nav-cta" href="new-trip.html" style="padding: 10px 18px; font-size: 14px;">
                        + New Trip
                    </a>
                </div>
            </div>
        </nav>
        <div class="global-nav-spacer"></div>
    `;
    if (!BACKEND_ONLINE) {
        const offline = document.createElement('div');
        offline.style.cssText = 'text-align:center;background:rgba(234,179,8,0.12);color:#facc15;padding:8px 16px;font-size:13px;border-bottom:1px solid rgba(234,179,8,0.25);';
        offline.innerHTML = '⚠️ Running offline — changes saved locally only. Will sync when MongoDB becomes available.';
        header.appendChild(offline);
    }
}

function initAuthForm(type) {
    const form = document.getElementById(`${type}-form`);
    if (!form) return;
    if (getAuth()) {
        window.location.replace('account.html');
        return;
    }
    const error = document.getElementById('auth-error');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        error.hidden = true;
        try {
            const fields = Object.fromEntries(new FormData(form).entries());
            const result = await authRequest(type === 'signup' ? '/signup' : '/login', fields);
            saveAuth(result);
            window.location.assign('home.html');
        } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            button.disabled = false;
        }
    });
}

function initAccountPage() {
    const auth = getAuth();
    if (!auth) {
        window.location.replace('login.html');
        return;
    }
    document.getElementById('account-name').textContent = auth.user.name;
    document.getElementById('account-email').textContent = auth.user.email;
    document.getElementById('logout-button').addEventListener('click', () => {
        clearAuth();
        window.location.assign('index.html');
    });
}

function renderBreadcrumb(segments) {
    const slot = document.getElementById('breadcrumb-slot');
    if (!slot) return;
    if (!segments || segments.length === 0) { slot.innerHTML = ''; return; }
    slot.innerHTML = `
        <div class="breadcrumb">
            ${segments.map((seg, i) => {
                const last = i === segments.length - 1;
                const cls = last ? 'breadcrumb-item breadcrumb-current' : 'breadcrumb-item';
                const inner = last
                    ? escapeHTML(seg.label)
                    : `<a href="${seg.href}">${escapeHTML(seg.label)}</a>`;
                const sep = !last ? `<span class="breadcrumb-sep">›</span>` : '';
                return `<div class="${cls}">${inner}</div>${sep}`;
            }).join('')}
        </div>
    `;
}

function injectToastRoot() {
    if (!document.getElementById('toast-root')) {
        const root = document.createElement('div');
        root.id = 'toast-root';
        root.className = 'toast-root';
        document.body.appendChild(root);
    }
}

function injectSharedChrome(pageId, segments, navActiveOverride) {
    const meta = PAGES[pageId] || PAGES.notFound;
    const activeKey = (navActiveOverride !== undefined && navActiveOverride !== null)
        ? navActiveOverride
        : meta.navActive;
    if (activeKey !== null) {
        renderNav(activeKey);
    }
    renderBreadcrumb(segments || []);
    injectToastRoot();
}

/* =========================================================
   TOAST NOTIFICATIONS
========================================================= */

function showToast(message, type = 'info', durationMs = 3000) {
    injectToastRoot();
    const root = document.getElementById('toast-root');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    toast.innerHTML = `<div style="display:flex;gap:10px;align-items:flex-start;"><span style="font-size:16px;">${icon}</span><div style="flex:1;">${escapeHTML(message)}</div></div>`;
    root.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        toast.style.transition = 'opacity .25s ease, transform .25s ease';
    }, durationMs - 250);
    setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, durationMs);
}

/* =========================================================
   INLINE MESSAGE (FORM BANNERS)
========================================================= */

function showMessage(containerId, text, type = 'error') {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.className = `message form-${type === 'success' ? 'success' : 'error'}-banner`;
    el.textContent = text;
    el.style.display = 'block';
}

function hideMessage(containerId) {
    const el = document.getElementById(containerId);
    if (el) { el.style.display = 'none'; el.textContent = ''; el.className = ''; }
}

function showError(elementId, message) { showMessage(elementId, message, 'error'); }
function showSuccess(elementId, message) { showMessage(elementId, message, 'success'); }

/* =========================================================
   CONFETTI
========================================================= */

function triggerConfetti(count = 80, colors = ['#6366f1','#06b6d4','#f472b6','#fbbf24','#34d399','#f87171']) {
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;overflow:hidden;pointer-events:none;z-index:200;';
    document.body.appendChild(layer);
    for (let i = 0; i < count; i++) {
        const p = document.createElement('span');
        p.className = 'confetti-piece';
        const left = Math.random() * 100;
        const delay = Math.random() * 0.3;
        const color = colors[i % colors.length];
        p.style.cssText = `
            left: ${left}vw;
            top: -10px;
            background: ${color};
            animation-delay: ${delay}s;
            border-radius: ${i % 2 === 0 ? '2px' : '50%'};
            width: ${6 + Math.random() * 6}px;
            height: ${6 + Math.random() * 8}px;
        `;
        layer.appendChild(p);
    }
    setTimeout(() => {
        if (layer.parentNode) layer.parentNode.removeChild(layer);
    }, 2200);
}

/* =========================================================
   STATE BOOTSTRAP — runs on every page DOMContentLoaded after
   fullLoad, hydrates currentTripIndex / currentMemberIndex
   etc. from ?tripId / ?memberIdx / ?past query params.
========================================================= */

function bootstrapStateFromQuery() {
    const q = getQuery();
    currentTripIndex = null;
    currentMemberIndex = null;
    viewingPastTripIndex = null;
    if (q.tripId) {
        const f = findTripByLocalId(q.tripId);
        if (f) {
            if (f.isPast) {
                viewingPastTripIndex = f.index;
            } else {
                currentTripIndex = f.index;
            }
        }
    }
    if (q.memberIdx !== undefined && q.memberIdx !== null && q.memberIdx !== '') {
        const idx = parseInt(q.memberIdx, 10);
        if (!Number.isNaN(idx) && idx >= 0) currentMemberIndex = idx;
    }
    if (q.past === '1' && viewingPastTripIndex === null && q.tripId) {
        // tripId might be in ongoing but user wants past-view; leave null if not found
    }
}

function currentTripCtx() {
    if (viewingPastTripIndex !== null && pastTripsData[viewingPastTripIndex]) {
        return { trip: pastTripsData[viewingPastTripIndex], isPast: true, refArray: pastTripsData, refIndex: viewingPastTripIndex };
    }
    if (currentTripIndex !== null && ongoingTripsData[currentTripIndex]) {
        return { trip: ongoingTripsData[currentTripIndex], isPast: false, refArray: ongoingTripsData, refIndex: currentTripIndex };
    }
    return null;
}

function currentLocalIdOfTrip() {
    const ctx = currentTripCtx();
    return ctx ? ctx.trip.localId : null;
}

/* =========================================================
   CURRENCY HELPERS
========================================================= */

function getCurrencySymbol(code) {
    const cur = CURRENCIES.find(c => c.code === code);
    return cur ? cur.symbol : '₹';
}

function resolveCurrencyCtx() {
    const ctx = currentTripCtx();
    if (ctx) return ctx.trip.currency || 'INR';
    return 'INR';
}

function formatMoney(amount, currencyOverride) {
    const code = currencyOverride || resolveCurrencyCtx();
    const symbol = getCurrencySymbol(code);
    return symbol + Number(amount).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function renderCurrencySelect(selectedCode, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = CURRENCIES.map(c =>
        `<option value="${c.code}" ${c.code === selectedCode ? 'selected' : ''}>${c.symbol} ${c.name} (${c.code})</option>`
    ).join('');
}

/* =========================================================
   DATE PICKER
========================================================= */

function openDatePicker(inputId) {
    const input = document.getElementById(inputId);
    if (input && input.showPicker) {
        try { input.showPicker(); }
        catch (error) { input.focus(); }
    } else if (input) {
        input.focus();
    }
}

/* =========================================================
   PAGE: home.html (MENU)
========================================================= */

function pageHomeInit() {
    injectSharedChrome('home', [{ label: 'Home', href: 'home.html', current: true }]);
    const ogEl = document.getElementById('count-ongoing');
    const psEl = document.getElementById('count-past');
    if (ogEl) ogEl.textContent = ongoingTripsData.length;
    if (psEl) psEl.textContent = pastTripsData.length;
}

/* =========================================================
   PAGE: new-trip.html (CREATE / EDIT)
========================================================= */

function pageNewTripInit() {
    injectSharedChrome('newTrip', [
        { label: 'Home', href: 'home.html' },
        { label: 'New Trip', current: true }
    ]);

    const q = getQuery();
    let prefill = null;
    if (q.tripId) {
        const f = findTripByLocalId(q.tripId);
        if (f && !f.isPast) {
            prefill = f.trip;
            editingTripIndex = f.index;
        }
    }
    if (!prefill) prefill = loadDraftTrip();

    if (prefill) {
        const destEl = document.getElementById('destination');
        const startEl = document.getElementById('startDate');
        const endEl = document.getElementById('endDate');
        if (destEl && prefill.destination) destEl.value = prefill.destination;
        if (startEl && prefill.startDate) startEl.value = prefill.startDate;
        if (endEl && prefill.endDate) endEl.value = prefill.endDate;
        memberCount = Number(prefill.memberCount) || 4;
        if (memberCount < 2) memberCount = 2;
        renderCurrencySelect(prefill.currency || 'INR', 'currencySelect');
    } else {
        memberCount = 4;
        renderCurrencySelect('INR', 'currencySelect');
    }
    const cntEl = document.getElementById('memberCount');
    if (cntEl) cntEl.textContent = memberCount;

    const pageH = document.querySelector('#newtrip-page-title');
    if (pageH && editingTripIndex !== null) pageH.textContent = 'Edit Trip';
}

function changeMembers(change) {
    memberCount += change;
    if (memberCount < 2) memberCount = 2;
    if (memberCount > 20) memberCount = 20;
    const cntEl = document.getElementById('memberCount');
    if (cntEl) cntEl.textContent = memberCount;
}

function createTrip() {
    const destination = document.getElementById("destination").value.trim();
    const startDate = document.getElementById("startDate").value;
    const endDate = document.getElementById("endDate").value;
    const currency = document.getElementById("currencySelect").value;

    hideMessage("newTripError");

    if (!destination || !startDate || !endDate || memberCount < 2) {
        showError("newTripError", "⚠️ Please enter all trip details correctly (min. 2 members).");
        return;
    }
    if (new Date(startDate) > new Date(endDate)) {
        showError("newTripError", "⚠️ Trip start date cannot be after the trip end date.");
        return;
    }

    const draft = { destination, startDate, endDate, currency, memberCount };
    if (editingTripIndex !== null && ongoingTripsData[editingTripIndex]) {
        const oldTrip = ongoingTripsData[editingTripIndex];
        draft._id = oldTrip._id;
        draft.localId = oldTrip.localId;
        draft.existingMembers = oldTrip.members.slice(0, memberCount).map(m => m.name);
    }
    saveDraftTrip(draft);
    navigate('/member-names.html');
}

/* =========================================================
   PAGE: member-names.html
========================================================= */

function pageMemberNamesInit() {
    injectSharedChrome('memberNames', [
        { label: 'Home', href: 'home.html' },
        { label: 'New Trip', href: 'new-trip.html' },
        { label: 'Trip Members', current: true }
    ]);

    const draft = loadDraftTrip();
    if (!draft || !draft.memberCount || !draft.destination) {
        showToast('No trip draft found — starting a new trip.', 'info');
        setTimeout(() => navigate('/new-trip.html'), 400);
        return;
    }
    memberCount = Number(draft.memberCount) || 4;
    if (memberCount < 2) memberCount = 2;
    generateMemberInputs(draft.existingMembers || []);
}

function generateMemberInputs(prefillNames) {
    const container = document.getElementById("memberInputs");
    if (!container) return;
    container.innerHTML = "";
    for (let i = 0; i < memberCount; i++) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-bottom:14px;';
        const input = document.createElement("input");
        input.type = "text";
        input.className = "member-input";
        input.placeholder = "Member " + (i + 1) + " name";
        input.id = "member" + i;
        if (prefillNames[i]) input.value = prefillNames[i];
        wrap.appendChild(input);
        container.appendChild(wrap);
    }
}

async function startTrip() {
    hideMessage("memberError");
    const draft = loadDraftTrip();
    if (!draft) { navigate('/new-trip.html'); return; }

    const names = [];
    for (let i = 0; i < memberCount; i++) {
        const input = document.getElementById("member" + i);
        if (!input) continue;
        const name = input.value.trim();
        if (!name) {
            showError("memberError", "⚠️ Please enter all member names before starting the trip.");
            return;
        }
        names.push(name);
    }
    const normalizedNames = names.map(n => n.toLowerCase());
    const uniqueNames = new Set(normalizedNames);
    if (uniqueNames.size !== names.length) {
        showError("memberError", "⚠️ Please use different names for each member.");
        return;
    }

    const existingMembers = (draft.existingMembers || []);
    const members = names.map((name, idx) => {
        const origIdx = existingMembers.indexOf(name);
        if (origIdx >= 0 && editingTripIndex !== null && ongoingTripsData[editingTripIndex]) {
            const m = ongoingTripsData[editingTripIndex].members[origIdx];
            if (m) return { name, expenses: m.expenses ? m.expenses.slice() : [] };
        }
        return { name, expenses: [] };
    });

    let localIdx;
    if (editingTripIndex !== null && ongoingTripsData[editingTripIndex]) {
        const old = ongoingTripsData[editingTripIndex];
        ongoingTripsData[editingTripIndex] = {
            ...old,
            destination: draft.destination,
            startDate: draft.startDate,
            endDate: draft.endDate,
            currency: draft.currency,
            memberCount,
            members
        };
        localIdx = editingTripIndex;
    } else {
        const newTrip = {
            destination: draft.destination,
            startDate: draft.startDate,
            endDate: draft.endDate,
            currency: draft.currency,
            memberCount,
            members,
            isCompleted: false,
            localId: (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : 'trip-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
        };
        if (draft._id) newTrip._id = draft._id;
        if (draft.localId) newTrip.localId = draft.localId;
        ongoingTripsData.push(newTrip);
        localIdx = ongoingTripsData.length - 1;
    }

    persistAll();

    try {
        const payload = JSON.parse(JSON.stringify(ongoingTripsData[localIdx]));
        const hasId = !!payload._id;
        delete payload._id; delete payload.__v; delete payload.createdAt; delete payload.updatedAt; delete payload.localId;
        let result;
        if (hasId) result = await api('PUT', `/${ongoingTripsData[localIdx]._id}`, stripInternal(ongoingTripsData[localIdx]));
        else result = await api('POST', '/', stripInternal(ongoingTripsData[localIdx]));
        if (result && result._id) {
            ongoingTripsData[localIdx]._id = result._id;
            saveToStorage();
        }
    } catch (e) {
        console.warn('Backend save failed, using local storage only.', e);
    }

    clearDraftTrip();
    editingTripIndex = null;
    showToast('Trip started successfully!', 'success', 2500);
    navigate('/dashboard.html', { tripId: ongoingTripsData[localIdx].localId });
}

/* =========================================================
   PAGE: dashboard.html
========================================================= */

function pageDashboardInit() {
    bootstrapStateFromQuery();
    const ctx = currentTripCtx();
    if (!ctx) {
        showToast('Trip not found. Returning home.', 'error');
        setTimeout(() => navigate('/home.html'), 600);
        return;
    }
    injectSharedChrome('dashboard', [
        { label: 'Home', href: 'home.html' },
        { label: 'Ongoing Trips', href: 'ongoing.html' },
        { label: `Trip: ${ctx.trip.destination}`, href: `trip-members.html?tripId=${ctx.trip.localId}` },
        { label: 'Dashboard', current: true }
    ]);

    loadDashboard(ctx.trip);
    const editBtn = document.getElementById('editTripLink');
    if (editBtn) editBtn.href = `new-trip.html?tripId=${ctx.trip.localId}`;
    const manageBtn = document.getElementById('manageExpensesBtn');
    if (manageBtn) manageBtn.href = `trip-members.html?tripId=${ctx.trip.localId}`;

    setTimeout(() => triggerConfetti(70), 150);
}

function loadDashboard(trip) {
    const info = document.getElementById("dashboardTripInfo");
    const membersEl = document.getElementById("dashboardMembers");
    if (info) info.innerHTML = `
        <div class="info-item"><span>Destination</span><strong>${escapeHTML(trip.destination)}</strong></div>
        <div class="info-item"><span>Members</span><strong>${trip.members.length}</strong></div>
        <div class="info-item"><span>Currency</span><strong>${getCurrencySymbol(trip.currency || 'INR')} ${trip.currency || 'INR'}</strong></div>
        <div class="info-item"><span>Dates</span><strong>${formatDate(trip.startDate)} - ${formatDate(trip.endDate)}</strong></div>
    `;
    if (membersEl) membersEl.innerHTML =
        trip.members.map(m => `<div class="member-chip">${escapeHTML(m.name)}</div>`).join("");
}

/* =========================================================
   PAGE: ongoing.html
========================================================= */

function pageOngoingInit() {
    bootstrapStateFromQuery();
    injectSharedChrome('ongoing', [
        { label: 'Home', href: 'home.html' },
        { label: 'Ongoing Trips', current: true }
    ]);
    renderOngoingTrips();
}

function renderOngoingTrips() {
    const container = document.getElementById("ongoingTripsList");
    if (!container) return;
    if (ongoingTripsData.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🧳</div>
                <h3>No Ongoing Trips</h3>
                <p>You haven't started any trips yet. Create a new trip and it will appear here.</p>
                <a class="primary-btn" href="new-trip.html">✈️ Create New Trip</a>
            </div>
        `;
        return;
    }
    container.innerHTML = ongoingTripsData.map((trip) => `
        <div class="trip-card" data-id="${trip.localId}">
            <div class="trip-card-top">
                <div class="trip-destination">${escapeHTML(trip.destination)}</div>
                <div class="ongoing-badge">ONGOING</div>
            </div>
            <div class="trip-dates">
                ${formatDate(trip.startDate)} → ${formatDate(trip.endDate)} &nbsp; • &nbsp;
                ${trip.members.length} members &nbsp; • &nbsp;
                ${getCurrencySymbol(trip.currency || 'INR')} ${trip.currency || 'INR'}
            </div>
            <div class="trip-card-members">
                ${trip.members.map(m => `<div class="small-member">${escapeHTML(m.name)}</div>`).join("")}
            </div>
            <div class="trip-card-actions">
                <a class="primary-btn" style="padding:10px 18px;font-size:14px;"
                   href="trip-members.html?tripId=${encodeURIComponent(trip.localId)}">
                    🧾 Open Trip
                </a>
                <button class="delete-btn" data-delete="${encodeURIComponent(trip.localId)}">🗑️ Delete</button>
            </div>
        </div>
    `).join("");
    container.querySelectorAll('[data-delete]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = btn.getAttribute('data-delete');
            deleteOngoingTripByLocalId(id);
        });
    });
}

function deleteOngoingTripByLocalId(localId) {
    const f = findTripByLocalId(localId);
    if (!f || f.isPast) return;
    const trip = f.trip;
    if (!confirm(`Delete the trip to "${trip.destination}"? This cannot be undone.`)) return;
    ongoingTripsData.splice(f.index, 1);
    persistAll();
    if (trip._id) { try { api('DELETE', `/${trip._id}`); } catch (e) {} }
    renderOngoingTrips();
    showToast('Trip deleted.', 'info', 2000);
}

/* =========================================================
   PAGE: past.html
========================================================= */

function pagePastInit() {
    bootstrapStateFromQuery();
    injectSharedChrome('past', [
        { label: 'Home', href: 'home.html' },
        { label: 'Past Trips', current: true }
    ]);
    renderPastTrips();
}

function renderPastTrips() {
    const container = document.getElementById("pastTripsList");
    if (!container) return;
    if (pastTripsData.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📜</div>
                <h3>No Past Trips Yet</h3>
                <p>Completed trips will appear here after you finish a trip and click "End Trip".</p>
                <a class="primary-btn" href="home.html">🏠 Go Home & Start a Trip</a>
            </div>
        `;
        return;
    }
    container.innerHTML = pastTripsData.map((trip) => {
        const cur = trip.currency || 'INR';
        const total = trip.summary ? trip.summary.totalExpense : 0;
        return `
            <div class="trip-card past-trip-card">
                <div class="trip-card-top">
                    <div class="trip-destination">${escapeHTML(trip.destination)}</div>
                    <div class="past-badge">COMPLETED</div>
                </div>
                <div class="trip-dates">
                    ${formatDate(trip.startDate)} → ${formatDate(trip.endDate)} &nbsp; • &nbsp;
                    ${trip.members.length} members &nbsp; • &nbsp;
                    Total: ${formatMoney(total, cur)}
                </div>
                <div class="trip-card-members">
                    ${trip.members.map(m => `<div class="small-member">${escapeHTML(m.name)}</div>`).join("")}
                </div>
                <div class="trip-card-actions">
                    <a class="primary-btn" style="padding:10px 18px;font-size:14px;"
                       href="summary.html?tripId=${encodeURIComponent(trip.localId)}&past=1">
                        📊 View Summary
                    </a>
                    <button class="delete-btn" data-delete="${encodeURIComponent(trip.localId)}">🗑️ Delete</button>
                </div>
            </div>
        `;
    }).join("");
    container.querySelectorAll('[data-delete]').forEach(btn => {
        btn.addEventListener('click', () => {
            deletePastTripByLocalId(btn.getAttribute('data-delete'));
        });
    });
}

function deletePastTripByLocalId(localId) {
    const f = findTripByLocalId(localId);
    if (!f || !f.isPast) return;
    const trip = f.trip;
    if (!confirm(`Delete past trip to "${trip.destination}"? This cannot be undone.`)) return;
    pastTripsData.splice(f.index, 1);
    persistAll();
    if (trip._id) { try { api('DELETE', `/${trip._id}`); } catch (e) {} }
    renderPastTrips();
    showToast('Past trip deleted.', 'info', 2000);
}

/* =========================================================
   PAGE: trip-members.html
========================================================= */

function pageTripMembersInit() {
    bootstrapStateFromQuery();
    const ctx = currentTripCtx();
    if (!ctx) {
        showToast('Trip not found.', 'error');
        setTimeout(() => navigate('/home.html'), 500);
        return;
    }
    const segs = [
        { label: 'Home', href: 'home.html' },
        { label: ctx.isPast ? 'Past Trips' : 'Ongoing Trips', href: ctx.isPast ? 'past.html' : 'ongoing.html' },
        { label: `Trip: ${ctx.trip.destination}`, href: ctx.isPast
            ? `summary.html?tripId=${ctx.trip.localId}&past=1`
            : `trip-members.html?tripId=${ctx.trip.localId}` },
        { label: 'Members', current: true }
    ];
    injectSharedChrome('tripMembers', segs, ctx.isPast ? 'past' : 'ongoing');
    renderMemberSelection(ctx);
}

function renderMemberSelection(ctx) {
    ctx = ctx || currentTripCtx();
    if (!ctx) return;
    const title = document.getElementById("memberSelectionTitle");
    if (title) title.textContent = ctx.trip.destination + " — Members";
    const container = document.getElementById("memberSelectionGrid");
    if (container) container.innerHTML = ctx.trip.members.map((member, index) => {
        const totalSpent = member.expenses.reduce((s, e) => s + Number(e.amount), 0);
        return `
            <a class="member-select-card" tabindex="0"
               href="expense.html?tripId=${encodeURIComponent(ctx.trip.localId)}&memberIdx=${index}">
                <div class="member-avatar">${escapeHTML(member.name.charAt(0).toUpperCase())}</div>
                <h3>${escapeHTML(member.name)}</h3>
                <p>
                    ${member.expenses.length} ${member.expenses.length === 1 ? 'expense' : 'expenses'}
                    <br>Total: ${formatMoney(totalSpent, ctx.trip.currency)}
                </p>
            </a>
        `;
    }).join("");

    const completeBtn = document.getElementById("completeTripBtn");
    if (completeBtn) {
        if (ctx.isPast) {
            completeBtn.style.display = 'none';
        } else {
            completeBtn.style.display = 'inline-flex';
            completeBtn.onclick = () => {
                const summary = buildSummaryData(ctx.trip);
                ctx.trip.summary = summary;
                persistAll();
                navigate('/summary.html', { tripId: ctx.trip.localId });
            };
        }
    }
}

/* =========================================================
   PAGE: expense.html
========================================================= */

function pageExpenseInit() {
    bootstrapStateFromQuery();
    const ctx = currentTripCtx();
    if (!ctx || ctx.isPast || currentMemberIndex === null || !ctx.trip.members[currentMemberIndex]) {
        showToast('Invalid expense context. Returning to trip members.', 'error');
        const lid = currentLocalIdOfTrip();
        setTimeout(() => navigate('/trip-members.html', lid ? { tripId: lid } : undefined), 500);
        return;
    }
    const member = ctx.trip.members[currentMemberIndex];
    injectSharedChrome('expense', [
        { label: 'Home', href: 'home.html' },
        { label: 'Ongoing Trips', href: 'ongoing.html' },
        { label: `Trip: ${ctx.trip.destination}`, href: `trip-members.html?tripId=${ctx.trip.localId}` },
        { label: `Member: ${member.name}`, href: `trip-members.html?tripId=${ctx.trip.localId}` },
        { label: 'Add Expense', current: true }
    ]);
    customSplitMode = false;
    selectedSplitMemberIndices = [];
    renderSelectedMember(ctx, member);
    renderSplitSection(ctx);
    renderMemberExpenses(ctx, member);
    hideMessage("expenseError");
    hideMessage("expenseSuccess");
    resetExpenseForm();
}

function renderSelectedMember(ctx, member) {
    const box = document.getElementById("selectedMemberBox");
    if (!box) return;
    box.innerHTML = `
        <div class="member-avatar" style="margin:0;">${escapeHTML(member.name.charAt(0).toUpperCase())}</div>
        <div>
            <strong>${escapeHTML(member.name)}</strong>
            <div style="color:#94a3b8;font-size:13px;margin-top:4px;">Adding expenses paid by this member</div>
        </div>
    `;
}

function renderSplitSection(ctx) {
    ctx = ctx || currentTripCtx();
    if (!ctx) return;
    const container = document.getElementById('splitSectionContainer');
    if (!container) return;
    const allSelected = selectedSplitMemberIndices.length === 0 || selectedSplitMemberIndices.length === ctx.trip.members.length;
    const isAll = !customSplitMode || allSelected;
    container.innerHTML = `
        <div class="split-section">
            <div class="split-section-label">
                <label>💰 Split this expense with:</label>
                <button type="button" class="toggle-split-btn" id="toggleSplitBtn">
                    ${customSplitMode ? '✓ Custom Split' : '👥 Equal (All Members)'}
                </button>
            </div>
            <div style="color:#94a3b8;font-size:13px;">
                ${isAll
                    ? `Split equally among <strong style="color:#cbd5e1;">all ${ctx.trip.members.length} members</strong>`
                    : `Split among <strong style="color:#c7d2fe;">${selectedSplitMemberIndices.length} selected members</strong>`
                }
            </div>
            ${customSplitMode ? `
                <div class="split-members-grid" id="splitMembersGrid">
                    ${ctx.trip.members.map((m, i) => {
                        const isChecked = selectedSplitMemberIndices.length === 0
                            ? true
                            : selectedSplitMemberIndices.includes(i);
                        return `
                            <label class="split-member-item ${isChecked ? 'selected' : ''}">
                                <input type="checkbox" ${isChecked ? 'checked' : ''} data-i="${i}">
                                <span>${escapeHTML(m.name)}</span>
                            </label>
                        `;
                    }).join('')}
                </div>
            ` : ''}
        </div>
    `;
    const tgl = document.getElementById('toggleSplitBtn');
    if (tgl) tgl.addEventListener('click', (e) => {
        e.preventDefault();
        customSplitMode = !customSplitMode;
        if (customSplitMode) selectedSplitMemberIndices = ctx.trip.members.map((_, i) => i);
        else selectedSplitMemberIndices = [];
        renderSplitSection(ctx);
    });
    const grid = document.getElementById('splitMembersGrid');
    if (grid) grid.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
            const i = parseInt(cb.getAttribute('data-i'), 10);
            if (cb.checked) {
                if (!selectedSplitMemberIndices.includes(i)) selectedSplitMemberIndices.push(i);
            } else {
                selectedSplitMemberIndices = selectedSplitMemberIndices.filter(x => x !== i);
            }
            renderSplitSection(ctx);
        });
    });
}

function getEffectiveSplitIndices(ctx) {
    ctx = ctx || currentTripCtx();
    if (!ctx) return [];
    if (!customSplitMode || selectedSplitMemberIndices.length === 0) {
        return ctx.trip.members.map((_, i) => i);
    }
    return [...selectedSplitMemberIndices].sort((a, b) => a - b);
}

function resetExpenseForm() {
    const amt = document.getElementById("expenseAmount");
    const desc = document.getElementById("expenseDescription");
    const btn = document.getElementById("expenseSubmitBtn");
    if (amt) amt.value = "";
    if (desc) desc.value = "";
    if (btn) btn.textContent = "➕ Add Expense";
    editingExpenseIndex = null;
}

async function addExpense() {
    const ctx = currentTripCtx();
    if (!ctx || ctx.isPast || currentMemberIndex === null) return;
    const amountEl = document.getElementById("expenseAmount");
    const descEl = document.getElementById("expenseDescription");
    const amount = parseFloat(amountEl.value);
    const description = descEl.value.trim();
    hideMessage("expenseError"); hideMessage("expenseSuccess");

    if (!amount || amount <= 0 || !description) {
        showError("expenseError", "⚠️ Please enter a valid amount and description.");
        return;
    }
    const splitIndices = getEffectiveSplitIndices(ctx);
    if (splitIndices.length === 0) {
        showError("expenseError", "⚠️ Please select at least one member to split with.");
        return;
    }
    const member = ctx.trip.members[currentMemberIndex];
    const expenseData = { amount, description, splitAmong: splitIndices };
    let savedIdx;
    if (editingExpenseIndex !== null && member.expenses[editingExpenseIndex]) {
        member.expenses[editingExpenseIndex] = expenseData;
        savedIdx = editingExpenseIndex;
        showSuccess("expenseSuccess", "✅ Expense updated!");
        showToast('Expense updated.', 'success', 1800);
    } else {
        member.expenses.push(expenseData);
        savedIdx = member.expenses.length - 1;
        showSuccess("expenseSuccess", "✅ Expense added!");
        showToast('Expense added successfully.', 'success', 1800);
    }
    persistAll();
    if (ctx.trip._id) {
        try {
            const body = {
                memberIndex: currentMemberIndex,
                amount: expenseData.amount,
                description: expenseData.description,
                splitAmong: expenseData.splitAmong
            };
            if (editingExpenseIndex !== null) {
                body.expenseIndex = savedIdx;
                await api('PUT', `/${ctx.trip._id}/expenses`, body);
            } else {
                await api('POST', `/${ctx.trip._id}/expenses`, body);
            }
        } catch (e) {
            console.warn('Backend expense update failed.', e);
        }
    }
    resetExpenseForm();
    renderMemberExpenses(ctx, member);
    renderSelectedMember(ctx, member);
    renderSplitSection(ctx);
}

function editExpense(expenseIndex) {
    const ctx = currentTripCtx();
    if (!ctx) return;
    const member = ctx.trip.members[currentMemberIndex];
    const exp = member.expenses[expenseIndex];
    if (!exp) return;
    editingExpenseIndex = expenseIndex;
    document.getElementById("expenseAmount").value = exp.amount;
    document.getElementById("expenseDescription").value = exp.description;
    if (exp.splitAmong && exp.splitAmong.length > 0 && exp.splitAmong.length !== ctx.trip.members.length) {
        customSplitMode = true;
        selectedSplitMemberIndices = [...exp.splitAmong];
    } else {
        customSplitMode = false;
        selectedSplitMemberIndices = [];
    }
    renderSplitSection(ctx);
    const btn = document.getElementById("expenseSubmitBtn");
    if (btn) btn.textContent = "💾 Update Expense";
    hideMessage("expenseError"); hideMessage("expenseSuccess");
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteExpense(expenseIndex) {
    const ctx = currentTripCtx();
    if (!ctx) return;
    const member = ctx.trip.members[currentMemberIndex];
    const exp = member.expenses[expenseIndex];
    if (!exp) return;
    if (!confirm(`Delete expense "${exp.description}" (${formatMoney(exp.amount, ctx.trip.currency)})?`)) return;
    member.expenses.splice(expenseIndex, 1);
    if (editingExpenseIndex === expenseIndex) resetExpenseForm();
    else if (editingExpenseIndex !== null && editingExpenseIndex > expenseIndex) editingExpenseIndex--;
    persistAll();
    renderMemberExpenses(ctx, member);
    renderSelectedMember(ctx, member);
    if (ctx.trip._id) {
        try {
            await api('DELETE', `/${ctx.trip._id}/expenses`, { memberIndex: currentMemberIndex, expenseIndex });
        } catch (e) {}
    }
    showToast('Expense deleted.', 'info', 1600);
}

function renderMemberExpenses(ctx, member) {
    ctx = ctx || currentTripCtx();
    if (!ctx) return;
    const container = document.getElementById("memberExpenseList");
    if (!container) return;
    if (member.expenses.length === 0) {
        container.innerHTML = `<p style="color:#64748b;font-size:14px;">No expenses added yet for this member.</p>`;
        return;
    }
    container.innerHTML = member.expenses.map((expense, idx) => {
        let splitText = '';
        if (expense.splitAmong && expense.splitAmong.length > 0 && expense.splitAmong.length !== ctx.trip.members.length) {
            const names = expense.splitAmong.map(i => ctx.trip.members[i]?.name || '').filter(Boolean);
            splitText = `<div class="expense-meta">👥 Split with: ${names.map(n => escapeHTML(n)).join(', ')}</div>`;
        }
        return `
            <div class="expense-item">
                <div class="expense-item-left">
                    <div class="expense-description">${escapeHTML(expense.description)}</div>
                    ${splitText}
                </div>
                <div class="expense-item-right">
                    <div class="expense-amount">${formatMoney(expense.amount, ctx.trip.currency)}</div>
                    <div class="expense-actions">
                        <button class="expense-edit-btn" data-edit="${idx}">✏️ Edit</button>
                        <button class="expense-delete-btn" data-del="${idx}">🗑️</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    container.querySelectorAll('[data-edit]').forEach(b => {
        b.addEventListener('click', () => editExpense(parseInt(b.getAttribute('data-edit'), 10)));
    });
    container.querySelectorAll('[data-del]').forEach(b => {
        b.addEventListener('click', () => deleteExpense(parseInt(b.getAttribute('data-del'), 10)));
    });
}

/* =========================================================
   PAGE: summary.html
========================================================= */

function pageSummaryInit() {
    bootstrapStateFromQuery();
    const ctx = currentTripCtx();
    if (!ctx) {
        const q = getQuery();
        const dest = q.past === '1' ? '/past.html' : '/home.html';
        showToast('Trip not found.', 'error');
        setTimeout(() => navigate(dest), 500);
        return;
    }
    injectSharedChrome('summary', [
        { label: 'Home', href: 'home.html' },
        { label: ctx.isPast ? 'Past Trips' : 'Ongoing Trips', href: ctx.isPast ? 'past.html' : 'ongoing.html' },
        { label: `Trip: ${ctx.trip.destination}`, href: ctx.isPast
            ? `summary.html?tripId=${ctx.trip.localId}&past=1`
            : `trip-members.html?tripId=${ctx.trip.localId}` },
        { label: 'Summary', current: true }
    ], ctx.isPast ? 'past' : 'ongoing');
    const summary = ctx.trip.summary || buildSummaryData(ctx.trip);
    ctx.trip.summary = summary;
    renderSummary(ctx.trip, summary);
    const section = document.getElementById("endTripSection");
    const backBtn = document.getElementById("summaryBackButton");
    if (section) section.style.display = ctx.isPast ? 'none' : 'block';
    if (backBtn) {
        backBtn.style.display = 'inline-block';
        backBtn.href = ctx.isPast
            ? 'past.html'
            : `trip-members.html?tripId=${ctx.trip.localId}`;
    }
    const shareBtn = document.getElementById('shareSummaryBtn');
    if (shareBtn) shareBtn.style.display = 'inline-block';
    const endBtn = document.getElementById('endTripBtn');
    if (endBtn) endBtn.addEventListener('click', () => endTrip());
}

function buildSummaryData(trip) {
    let totalExpense = 0;
    const n = trip.members.length;
    const personPaid = new Array(n).fill(0);
    const personOwe = new Array(n).fill(0);
    trip.members.forEach((member, payerIdx) => {
        (member.expenses || []).forEach(expense => {
            const amt = Number(expense.amount);
            totalExpense += amt;
            personPaid[payerIdx] += amt;
            const splitAmong = expense.splitAmong && expense.splitAmong.length > 0
                ? expense.splitAmong
                : trip.members.map((_, i) => i);
            const share = amt / splitAmong.length;
            splitAmong.forEach(i => {
                if (i >= 0 && i < n) personOwe[i] += share;
            });
        });
    });
    const perPersonBalances = trip.members.map((member, i) => ({
        name: member.name,
        spent: personPaid[i],
        balance: personPaid[i] - personOwe[i]
    }));
    const settlements = calculateSettlementsFromBalances(
        perPersonBalances.map(p => ({ name: p.name, amount: p.balance }))
    );
    return {
        totalExpense,
        personPaid,
        personOwe,
        personTotals: perPersonBalances.map(p => ({ name: p.name, spent: p.spent })),
        equalShare: n > 0 ? totalExpense / n : 0,
        settlements,
        perPersonBalances
    };
}

function calculateSettlementsFromBalances(balances) {
    const creditors = [];
    const debtors = [];
    balances.forEach(p => {
        if (p.amount > 0.005) creditors.push({ name: p.name, amount: p.amount });
        if (p.amount < -0.005) debtors.push({ name: p.name, amount: Math.abs(p.amount) });
    });
    const settlements = [];
    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
        const c = creditors[ci];
        const d = debtors[di];
        const amt = Math.min(c.amount, d.amount);
        settlements.push({ from: d.name, to: c.name, amount: amt });
        c.amount -= amt;
        d.amount -= amt;
        if (Math.abs(c.amount) < 0.005) ci++;
        if (Math.abs(d.amount) < 0.005) di++;
    }
    return settlements;
}

function renderSummary(trip, summary) {
    const cur = trip.currency || 'INR';
    const destH = document.getElementById("summaryDestination");
    if (destH) destH.textContent = trip.destination + " — Final Expense Summary";
    const totalEl = document.getElementById("summaryTotal");
    if (totalEl) totalEl.innerHTML = `<span>Total Money Spent</span><strong>${formatMoney(summary.totalExpense, cur)}</strong>`;
    const shareEl = document.getElementById("summaryShare");
    if (shareEl) shareEl.innerHTML = `<span>Average per Person (Total ÷ ${trip.members.length})</span><strong>${formatMoney(summary.equalShare, cur)}</strong>`;
    renderPersonSummary(summary.perPersonBalances || summary.personTotals, summary.equalShare, cur, summary);
    renderSettlements(summary.settlements, cur);
}

function renderPersonSummary(balances, equalShare, currency, fullSummary) {
    const container = document.getElementById("personSummary");
    if (!container) return;
    const renderBalance = (b, idx) => {
        const balance = typeof b.balance !== 'undefined' ? b.balance : (b.spent - equalShare);
        let balanceHTML;
        if (balance > 0.005) balanceHTML = `<div class="balance-positive">Gets back ${formatMoney(balance, currency)}</div>`;
        else if (balance < -0.005) balanceHTML = `<div class="balance-negative">Owes ${formatMoney(Math.abs(balance), currency)}</div>`;
        else balanceHTML = `<div style="color:#94a3b8;font-weight:700;">Settled</div>`;
        const spent = b.spent;
        const owe = fullSummary && fullSummary.personOwe
            ? fullSummary.personOwe[idx]
            : equalShare;
        return `
            <div class="summary-person">
                <div>
                    <div class="summary-person-name">${escapeHTML(b.name)}</div>
                    <div class="summary-person-spent">
                        Paid: ${formatMoney(spent, currency)}
                        ${fullSummary && fullSummary.personOwe ? ` • Their share: ${formatMoney(owe, currency)}` : ''}
                    </div>
                </div>
                ${balanceHTML}
            </div>
        `;
    };
    container.innerHTML = balances.map((b, i) => renderBalance(b, i)).join('');
}

function renderSettlements(settlements, currency) {
    const container = document.getElementById("settlementList");
    if (!container) return;
    if (settlements.length === 0) {
        container.innerHTML = `<div class="settlement-item">✅ Everyone is settled up!</div>`;
        return;
    }
    container.innerHTML = settlements.map(s => `
        <div class="settlement-item">
            <strong>${escapeHTML(s.from)}</strong> → <strong>${escapeHTML(s.to)}</strong>
            &nbsp; ${formatMoney(s.amount, currency)}
        </div>
    `).join("");
}

function shareSummary() {
    const ctx = currentTripCtx();
    if (!ctx) return;
    const trip = ctx.trip;
    const summary = trip.summary || buildSummaryData(trip);
    const cur = trip.currency || 'INR';
    const symbol = getCurrencySymbol(cur);
    let text = `🧳 TripSplit Summary — ${trip.destination}\n`;
    text += `📅 ${formatDate(trip.startDate)} → ${formatDate(trip.endDate)}\n`;
    if (ctx.isPast) text += `🏁 Completed trip\n`;
    text += `\n💰 Total: ${symbol}${Number(summary.totalExpense).toFixed(2)}\n`;
    text += `👥 Avg/person: ${symbol}${Number(summary.equalShare).toFixed(2)}\n\n`;
    text += `📊 Individual breakdown:\n`;
    (summary.perPersonBalances || summary.personTotals).forEach(p => {
        const bal = typeof p.balance !== 'undefined' ? p.balance : (p.spent - summary.equalShare);
        let status;
        if (bal > 0.005) status = `gets back ${symbol}${bal.toFixed(2)}`;
        else if (bal < -0.005) status = `owes ${symbol}${Math.abs(bal).toFixed(2)}`;
        else status = 'settled ✓';
        text += `  • ${p.name}: paid ${symbol}${Number(p.spent).toFixed(2)} → ${status}\n`;
    });
    if (summary.settlements.length > 0) {
        text += `\n💸 Settlements:\n`;
        summary.settlements.forEach(s => {
            text += `  → ${s.from} pays ${s.to} ${symbol}${Number(s.amount).toFixed(2)}\n`;
        });
    } else {
        text += `\n✅ Everyone is settled!\n`;
    }
    text += `\n— via TripSplit ✨`;
    const doFallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showToast('Summary copied to clipboard!', 'success', 2500);
        } catch (e) {
            prompt("Copy this summary:", text);
        }
        document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => showToast('Summary copied! Share it anywhere.', 'success', 2500))
            .catch(() => doFallback());
    } else {
        doFallback();
    }
}

async function endTrip() {
    const ctx = currentTripCtx();
    if (!ctx || ctx.isPast) return;
    const srcTrip = ctx.trip;
    if (!confirm(`End the trip to "${srcTrip.destination}"? This will move it to Past Trips and finalize settlements.`)) return;
    const completedTrip = JSON.parse(JSON.stringify(srcTrip));
    completedTrip.summary = buildSummaryData(completedTrip);
    completedTrip.isCompleted = true;
    completedTrip.completedDate = new Date().toISOString();
    pastTripsData.push(completedTrip);
    if (pastTripsData.length > 50) pastTripsData.shift();
    ongoingTripsData.splice(ctx.refIndex, 1);
    const remoteId = srcTrip._id;
    persistAll();
    if (remoteId) {
        try { await api('POST', `/${remoteId}/complete`); } catch (e) {}
    }
    showToast('Trip completed successfully!', 'success', 2500);
    triggerConfetti(100);
    setTimeout(() => navigate('/past.html'), 1100);
}

/* =========================================================
   FORMAT DATE
========================================================= */

function formatDate(dateString) {
    if (!dateString) return "";
    const date = new Date(dateString + "T00:00:00");
    return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/* =========================================================
   ESCAPE HTML
========================================================= */

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* =========================================================
   PAGE INIT ROUTER — called on DOMContentLoaded based on
   body[data-page] attribute (set on each HTML file).
========================================================= */

function detectPageId() {
    const body = document.body;
    if (!body) return null;
    return body.getAttribute('data-page');
}

async function initPage() {
    const pageId = detectPageId();
    if (pageId === 'signup' || pageId === 'login') {
        initAuthForm(pageId);
        return;
    }
    if (pageId === 'account') {
        initAccountPage();
        renderNav(null);
        return;
    }
    await fullLoad();
    api('GET', '/health').then((r) => {
        if (r && r.status === 'ok') {
            BACKEND_ONLINE = true;
            // Re-render nav to remove offline banner after it becomes available
            const pageId = detectPageId();
            const meta = PAGES[pageId];
            if (meta && meta.navActive !== null) renderNav(meta.navActive);
        } else {
            BACKEND_ONLINE = false;
        }
    }).catch(() => {
        BACKEND_ONLINE = false;
    });

    if (!pageId) return;

    switch (pageId) {
        case 'home':        pageHomeInit(); break;
        case 'newTrip':     pageNewTripInit(); break;
        case 'memberNames': pageMemberNamesInit(); break;
        case 'dashboard':   pageDashboardInit(); break;
        case 'ongoing':     pageOngoingInit(); break;
        case 'past':        pagePastInit(); break;
        case 'tripMembers': pageTripMembersInit(); break;
        case 'expense':     pageExpenseInit(); break;
        case 'summary':     pageSummaryInit(); break;
        case 'notFound':
        case 'landing':
            // landing page uses its own simpler hero nav chrome injection
            if (pageId === 'notFound') {
                injectSharedChrome('notFound', [{ label: 'Home', href: 'home.html' }, { label: '404', current: true }]);
            }
            break;
    }

    // Page enter animation trigger: add page-wrap-enter after microtask
    const wrap = document.getElementById('page-wrap');
    if (wrap) requestAnimationFrame(() => wrap.classList.add('page-wrap-enter'));
}

/* =========================================================
   DOM READY
========================================================= */

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
} else {
    initPage();
}

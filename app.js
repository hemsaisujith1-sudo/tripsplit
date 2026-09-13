/* =========================================================
   CONSTANTS & CONFIG
========================================================= */

const STORAGE_KEY_ONGOING = 'tripsplit_ongoing_trips';
const STORAGE_KEY_PAST = 'tripsplit_past_trips';
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
   GLOBAL STATE
========================================================= */

let memberCount = 4;
let ongoingTripsData = [];
let pastTripsData = [];
let currentTripIndex = null;
let currentMemberIndex = null;
let editingTripIndex = null;
let viewingPastTripIndex = null;
let editingExpenseIndex = null;
let customSplitMode = false;
let selectedSplitMemberIndices = [];
let syncTimeout = null;

let tripData = {
    destination: "",
    startDate: "",
    endDate: "",
    currency: "INR",
    memberCount: 4,
    members: []
};

/* =========================================================
   API HELPERS (graceful offline fallback)
========================================================= */

async function api(method, path, body) {
    if (BACKEND_ONLINE === false && method !== 'GET') return null;

    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
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
   LOCAL STORAGE
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
   FULL LOAD: API FIRST, FALLBACK TO STORAGE
========================================================= */

async function fullLoad() {
    loadFromStorage();

    const [ongoing, past] = await Promise.all([
        api('GET', '/ongoing'),
        api('GET', '/past')
    ]);

    if (ongoing && Array.isArray(ongoing)) {
        ongoingTripsData = ongoing.map(enrichWithLocalIds);
    }
    if (past && Array.isArray(past)) {
        pastTripsData = past.map(enrichWithLocalIds);
    }

    saveToStorage();
    fixRefsAfterReload();
}

function enrichWithLocalIds(t) {
    t.members.forEach((m) => {
        if (!Array.isArray(m.expenses)) m.expenses = [];
    });
    return t;
}

function fixRefsAfterReload() {
    if (currentTripIndex !== null && ongoingTripsData.length === 0) {
        currentTripIndex = null;
    }
}

/* =========================================================
   PERSIST HELPERS: SYNC TO BACKEND (debounced) + STORAGE
========================================================= */

function persistAll() {
    saveToStorage();
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        try {
            syncTripsToBackend().catch(() => {});
        } catch (e) {}
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
    if (copy.isCompleted) {
        delete copy.isCompleted;
        delete copy.completedDate;
    }
    return copy;
}

/* =========================================================
   PAGE CONTROL
========================================================= */

function showPage(pageId) {
    document.querySelectorAll(".page").forEach(page => {
        page.classList.remove("active");
    });

    const page = document.getElementById(pageId);
    if (page) {
        page.classList.add("active");
        window.scrollTo({ top: 0, behavior: "instant" });
    }
}

/* =========================================================
   CURRENCY HELPERS
========================================================= */

function getCurrencySymbol(code) {
    const cur = CURRENCIES.find(c => c.code === code);
    return cur ? cur.symbol : '₹';
}

function resolveCurrencyCtx() {
    if (viewingPastTripIndex !== null && pastTripsData[viewingPastTripIndex]) {
        return pastTripsData[viewingPastTripIndex].currency || 'INR';
    }
    if (currentTripIndex !== null && ongoingTripsData[currentTripIndex]) {
        return ongoingTripsData[currentTripIndex].currency || 'INR';
    }
    return tripData.currency || 'INR';
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
   HOME / MENU
========================================================= */

function showMenu() {
    editingTripIndex = null;
    viewingPastTripIndex = null;
    showPage("menuPage");
}

function goHome() {
    editingTripIndex = null;
    viewingPastTripIndex = null;
    showPage("menuPage");
}

function backToMenu() {
    editingTripIndex = null;
    showPage("menuPage");
}

/* =========================================================
   NEW TRIP
========================================================= */

function showNewTrip() {
    editingTripIndex = null;
    viewingPastTripIndex = null;
    resetNewTripForm();
    showPage("newTripPage");
}

function backToNewTrip() {
    showPage("newTripPage");
}

function resetNewTripForm() {
    document.getElementById("destination").value = "";
    document.getElementById("startDate").value = "";
    document.getElementById("endDate").value = "";
    memberCount = 4;
    document.getElementById("memberCount").textContent = memberCount;
    renderCurrencySelect('INR', 'currencySelect');
    hideMessage("newTripError");
}

/* =========================================================
   MEMBER COUNT
========================================================= */

function changeMembers(change) {
    memberCount += change;
    if (memberCount < 2) memberCount = 2;
    if (memberCount > 20) memberCount = 20;
    document.getElementById("memberCount").textContent = memberCount;
}

/* =========================================================
   DATE PICKER
========================================================= */

function openDatePicker(inputId) {
    const input = document.getElementById(inputId);
    if (input.showPicker) {
        try { input.showPicker(); }
        catch (error) { input.focus(); }
    } else {
        input.focus();
    }
}

/* =========================================================
   CREATE / EDIT TRIP (local + sync)
========================================================= */

function createTrip() {
    const destination = document.getElementById("destination").value.trim();
    const startDate = document.getElementById("startDate").value;
    const endDate = document.getElementById("endDate").value;
    const currency = document.getElementById("currencySelect").value;

    hideMessage("newTripError");

    if (!destination || !startDate || !endDate || memberCount < 2) {
        showError("newTripError", "⚠️ Please enter all trip details correctly.");
        return;
    }

    if (new Date(startDate) > new Date(endDate)) {
        showError("newTripError", "⚠️ Trip start date cannot be after the trip end date.");
        return;
    }

    if (editingTripIndex !== null && ongoingTripsData[editingTripIndex]) {
        const oldTrip = ongoingTripsData[editingTripIndex];
        tripData = {
            ...oldTrip,
            destination,
            startDate,
            endDate,
            currency,
            memberCount,
            members: oldTrip.members.slice(0, memberCount)
        };
        while (tripData.members.length < memberCount) {
            tripData.members.push({ name: "", expenses: [] });
        }
    } else {
        tripData = {
            destination,
            startDate,
            endDate,
            currency,
            memberCount,
            members: [],
            isCompleted: false
        };
    }

    generateMemberInputs();
    showPage("memberNamesPage");
}

/* =========================================================
   GENERATE MEMBER INPUTS
========================================================= */

function generateMemberInputs() {
    const container = document.getElementById("memberInputs");
    container.innerHTML = "";

    for (let i = 0; i < memberCount; i++) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "member-input";
        input.placeholder = "Member " + (i + 1) + " name";
        input.id = "member" + i;
        if (tripData.members[i] && tripData.members[i].name) {
            input.value = tripData.members[i].name;
        }
        container.appendChild(input);
    }
}

/* =========================================================
   START / UPDATE TRIP
========================================================= */

async function startTrip() {
    hideMessage("memberError");

    const names = [];
    for (let i = 0; i < memberCount; i++) {
        const input = document.getElementById("member" + i);
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

    const oldMembers = tripData.members || [];
    tripData.members = names.map((name, index) => ({
        name,
        expenses: oldMembers[index] && oldMembers[index].expenses ? oldMembers[index].expenses : []
    }));
    tripData.memberCount = memberCount;
    tripData.currency = tripData.currency || 'INR';

    let localIdx;
    if (editingTripIndex === null) {
        ongoingTripsData.push(JSON.parse(JSON.stringify(tripData)));
        localIdx = ongoingTripsData.length - 1;
    } else {
        ongoingTripsData[editingTripIndex] = JSON.parse(JSON.stringify(tripData));
        localIdx = editingTripIndex;
    }

    persistAll();

    try {
        const payload = JSON.parse(JSON.stringify(ongoingTripsData[localIdx]));
        const hasId = !!payload._id;
        delete payload._id;
        delete payload.__v;
        delete payload.createdAt;
        delete payload.updatedAt;

        let result;
        if (hasId) {
            result = await api('PUT', `/${ongoingTripsData[localIdx]._id}`, payload);
        } else {
            result = await api('POST', '/', payload);
        }
        if (result && result._id) {
            ongoingTripsData[localIdx]._id = result._id;
            saveToStorage();
        }
    } catch (e) {
        console.warn('Backend save failed, using local storage only.', e);
    }

    currentTripIndex = localIdx;
    editingTripIndex = null;
    loadDashboard();
    showPage("dashboardPage");
}

/* =========================================================
   EDIT CURRENT TRIP
========================================================= */

function editCurrentTrip() {
    if (currentTripIndex === null || !ongoingTripsData[currentTripIndex]) return;

    editingTripIndex = currentTripIndex;
    const trip = ongoingTripsData[currentTripIndex];

    document.getElementById("destination").value = trip.destination;
    document.getElementById("startDate").value = trip.startDate;
    document.getElementById("endDate").value = trip.endDate;
    memberCount = trip.members.length;
    document.getElementById("memberCount").textContent = memberCount;
    renderCurrencySelect(trip.currency || 'INR', 'currencySelect');

    tripData = JSON.parse(JSON.stringify(trip));
    showPage("newTripPage");
}

/* =========================================================
   DASHBOARD
========================================================= */

function loadDashboard() {
    const trip = ongoingTripsData[currentTripIndex];
    if (!trip) return;

    document.getElementById("dashboardTripInfo").innerHTML = `
        <div class="info-item">
            <span>Destination</span>
            <strong>${escapeHTML(trip.destination)}</strong>
        </div>
        <div class="info-item">
            <span>Members</span>
            <strong>${trip.members.length}</strong>
        </div>
        <div class="info-item">
            <span>Currency</span>
            <strong>${getCurrencySymbol(trip.currency || 'INR')} ${trip.currency || 'INR'}</strong>
        </div>
        <div class="info-item">
            <span>Dates</span>
            <strong>${formatDate(trip.startDate)} - ${formatDate(trip.endDate)}</strong>
        </div>
    `;

    document.getElementById("dashboardMembers").innerHTML =
        trip.members.map(member => `
            <div class="member-chip">${escapeHTML(member.name)}</div>
        `).join("");
}

/* =========================================================
   ONGOING TRIPS
========================================================= */

function showOngoingTrips() {
    renderOngoingTrips();
    showPage("ongoingTripsPage");
}

function renderOngoingTrips() {
    const container = document.getElementById("ongoingTripsList");

    if (ongoingTripsData.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🧳</div>
                <h3>No Ongoing Trips</h3>
                <p>You haven't started any trips yet. Create a new trip and it will appear here.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = ongoingTripsData.map((trip, index) => `
        <div class="trip-card" onclick="if(!event.target.closest('.delete-btn')) openTrip(${index})">
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
                ${trip.members.map(member => `
                    <div class="small-member">${escapeHTML(member.name)}</div>
                `).join("")}
            </div>
            <div class="trip-card-actions">
                <button class="delete-btn" onclick="event.stopPropagation(); deleteOngoingTrip(${index})">
                    🗑️ Delete Trip
                </button>
            </div>
        </div>
    `).join("");
}

/* =========================================================
   DELETE ONGOING TRIP
========================================================= */

async function deleteOngoingTrip(index) {
    const trip = ongoingTripsData[index];
    if (!trip) return;

    if (!confirm(`Are you sure you want to delete the trip to "${trip.destination}"? This action cannot be undone.`)) {
        return;
    }

    const id = trip._id;
    ongoingTripsData.splice(index, 1);
    persistAll();

    if (currentTripIndex === index) currentTripIndex = null;
    else if (currentTripIndex !== null && currentTripIndex > index) currentTripIndex--;

    renderOngoingTrips();

    if (id) {
        try { await api('DELETE', `/${id}`); } catch (e) {}
    }
}

/* =========================================================
   OPEN ONGOING TRIP
========================================================= */

function openTrip(index) {
    currentTripIndex = index;
    currentMemberIndex = null;
    renderMemberSelection();
    showPage("memberSelectionPage");
}

/* =========================================================
   MEMBER SELECTION
========================================================= */

function renderMemberSelection() {
    const trip = ongoingTripsData[currentTripIndex];
    if (!trip) return;

    document.getElementById("memberSelectionTitle").textContent = trip.destination + " — Members";

    const container = document.getElementById("memberSelectionGrid");
    container.innerHTML = trip.members.map((member, index) => {
        const totalSpent = member.expenses.reduce((sum, e) => sum + Number(e.amount), 0);
        return `
            <div class="member-select-card" onclick="selectMember(${index})">
                <div class="member-avatar">
                    ${escapeHTML(member.name.charAt(0).toUpperCase())}
                </div>
                <h3>${escapeHTML(member.name)}</h3>
                <p>
                    ${member.expenses.length} ${member.expenses.length === 1 ? 'expense' : 'expenses'}
                    <br>Total: ${formatMoney(totalSpent, trip.currency)}
                </p>
            </div>
        `;
    }).join("");
}

/* =========================================================
   SELECT MEMBER
========================================================= */

function selectMember(index) {
    currentMemberIndex = index;
    editingExpenseIndex = null;
    customSplitMode = false;
    selectedSplitMemberIndices = [];

    renderSelectedMember();
    renderSplitSection();
    renderMemberExpenses();

    hideMessage("expenseError");
    hideMessage("expenseSuccess");

    resetExpenseForm();
    showPage("expensePage");
}

/* =========================================================
   SELECTED MEMBER
========================================================= */

function renderSelectedMember() {
    const trip = ongoingTripsData[currentTripIndex];
    const member = trip.members[currentMemberIndex];

    document.getElementById("selectedMemberBox").innerHTML = `
        <div class="member-avatar" style="margin:0;">
            ${escapeHTML(member.name.charAt(0).toUpperCase())}
        </div>
        <div>
            <strong>${escapeHTML(member.name)}</strong>
            <div style="color:#94a3b8;font-size:13px;margin-top:4px;">
                Adding expenses for this member
            </div>
        </div>
    `;
}

/* =========================================================
   SPLIT SECTION
========================================================= */

function renderSplitSection() {
    const trip = ongoingTripsData[currentTripIndex];
    const container = document.getElementById('splitSectionContainer');
    if (!container) return;

    const allSelected = selectedSplitMemberIndices.length === 0 || selectedSplitMemberIndices.length === trip.members.length;
    const isAll = !customSplitMode || allSelected;

    container.innerHTML = `
        <div class="split-section">
            <div class="split-section-label">
                <label>💰 Split this expense with:</label>
                <button type="button" class="toggle-split-btn" onclick="toggleSplitMode()">
                    ${customSplitMode ? '✓ Custom Split' : '👥 Equal (All Members)'}
                </button>
            </div>
            <div style="color:#94a3b8;font-size:13px;">
                ${isAll
                    ? `Split equally among <strong style="color:#cbd5e1;">all ${trip.members.length} members</strong>`
                    : `Split among <strong style="color:#c7d2fe;">${selectedSplitMemberIndices.length} selected members</strong>`
                }
            </div>
            ${customSplitMode ? `
                <div class="split-members-grid">
                    ${trip.members.map((m, i) => {
                        const isChecked = selectedSplitMemberIndices.length === 0
                            ? true
                            : selectedSplitMemberIndices.includes(i);
                        return `
                            <label class="split-member-item ${isChecked ? 'selected' : ''}">
                                <input type="checkbox" ${isChecked ? 'checked' : ''}
                                    onchange="toggleSplitMember(${i}, this.checked)">
                                <span>${escapeHTML(m.name)}</span>
                            </label>
                        `;
                    }).join('')}
                </div>
            ` : ''}
        </div>
    `;
}

function toggleSplitMode() {
    customSplitMode = !customSplitMode;
    if (customSplitMode) {
        const trip = ongoingTripsData[currentTripIndex];
        selectedSplitMemberIndices = trip.members.map((_, i) => i);
    } else {
        selectedSplitMemberIndices = [];
    }
    renderSplitSection();
}

function toggleSplitMember(idx, checked) {
    if (checked) {
        if (!selectedSplitMemberIndices.includes(idx)) selectedSplitMemberIndices.push(idx);
    } else {
        selectedSplitMemberIndices = selectedSplitMemberIndices.filter(i => i !== idx);
    }
    renderSplitSection();
}

function getEffectiveSplitIndices() {
    const trip = ongoingTripsData[currentTripIndex];
    if (!customSplitMode || selectedSplitMemberIndices.length === 0) {
        return trip.members.map((_, i) => i);
    }
    return [...selectedSplitMemberIndices].sort((a, b) => a - b);
}

/* =========================================================
   RESET EXPENSE FORM
========================================================= */

function resetExpenseForm() {
    document.getElementById("expenseAmount").value = "";
    document.getElementById("expenseDescription").value = "";
    document.getElementById("expenseSubmitBtn").textContent = "➕ Add Expense";
    const title = document.querySelector('#expensePage .page-title');
    if (title) title.classList.remove('edit-expense-title');
    editingExpenseIndex = null;
}

/* =========================================================
   ADD / UPDATE EXPENSE
========================================================= */

async function addExpense() {
    const amount = parseFloat(document.getElementById("expenseAmount").value);
    const description = document.getElementById("expenseDescription").value.trim();

    hideMessage("expenseError");
    hideMessage("expenseSuccess");

    if (!amount || amount <= 0 || !description) {
        showError("expenseError", "⚠️ Please enter a valid amount and expense description.");
        return;
    }

    const splitIndices = getEffectiveSplitIndices();
    if (splitIndices.length === 0) {
        showError("expenseError", "⚠️ Please select at least one member to split this expense with.");
        return;
    }

    const trip = ongoingTripsData[currentTripIndex];
    const member = trip.members[currentMemberIndex];
    const tripId = trip._id;

    const expenseData = {
        amount,
        description,
        splitAmong: splitIndices
    };

    let savedExpenseIdx;
    if (editingExpenseIndex !== null && member.expenses[editingExpenseIndex]) {
        member.expenses[editingExpenseIndex] = expenseData;
        savedExpenseIdx = editingExpenseIndex;
        showSuccess("expenseSuccess", "✅ Expense updated successfully!");
    } else {
        member.expenses.push(expenseData);
        savedExpenseIdx = member.expenses.length - 1;
        showSuccess("expenseSuccess", "✅ Expense added successfully!");
    }

    persistAll();

    if (tripId) {
        try {
            const body = {
                memberIndex: currentMemberIndex,
                amount: expenseData.amount,
                description: expenseData.description,
                splitAmong: expenseData.splitAmong
            };
            if (editingExpenseIndex !== null) {
                body.expenseIndex = savedExpenseIdx;
                await api('PUT', `/${tripId}/expenses`, body);
            } else {
                await api('POST', `/${tripId}/expenses`, body);
            }
        } catch (e) {
            console.warn('Backend expense update failed, saved locally only.', e);
        }
    }

    resetExpenseForm();
    renderMemberExpenses();
    renderSelectedMember();
    renderSplitSection();
}

/* =========================================================
   EDIT EXPENSE
========================================================= */

function editExpense(expenseIndex) {
    const trip = ongoingTripsData[currentTripIndex];
    const member = trip.members[currentMemberIndex];
    const expense = member.expenses[expenseIndex];
    if (!expense) return;

    editingExpenseIndex = expenseIndex;
    document.getElementById("expenseAmount").value = expense.amount;
    document.getElementById("expenseDescription").value = expense.description;

    if (expense.splitAmong && expense.splitAmong.length > 0 && expense.splitAmong.length !== trip.members.length) {
        customSplitMode = true;
        selectedSplitMemberIndices = [...expense.splitAmong];
    } else {
        customSplitMode = false;
        selectedSplitMemberIndices = [];
    }

    renderSplitSection();
    document.getElementById("expenseSubmitBtn").textContent = "💾 Update Expense";
    const title = document.querySelector('#expensePage .page-title');
    if (title) title.classList.add('edit-expense-title');

    hideMessage("expenseError");
    hideMessage("expenseSuccess");
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* =========================================================
   DELETE EXPENSE
========================================================= */

async function deleteExpense(expenseIndex) {
    const trip = ongoingTripsData[currentTripIndex];
    const member = trip.members[currentMemberIndex];
    const expense = member.expenses[expenseIndex];
    if (!expense) return;

    if (!confirm(`Delete expense "${expense.description}" (${formatMoney(expense.amount, trip.currency)})?`)) return;

    member.expenses.splice(expenseIndex, 1);

    if (editingExpenseIndex === expenseIndex) resetExpenseForm();
    else if (editingExpenseIndex !== null && editingExpenseIndex > expenseIndex) editingExpenseIndex--;

    persistAll();
    renderMemberExpenses();
    renderSelectedMember();

    if (trip._id) {
        try {
            await api('DELETE', `/${trip._id}/expenses`, {
                memberIndex: currentMemberIndex,
                expenseIndex
            });
        } catch (e) {}
    }
}

/* =========================================================
   RENDER EXPENSES
========================================================= */

function renderMemberExpenses() {
    const trip = ongoingTripsData[currentTripIndex];
    const member = trip.members[currentMemberIndex];
    const container = document.getElementById("memberExpenseList");

    if (member.expenses.length === 0) {
        container.innerHTML = `
            <p style="color:#64748b;font-size:14px;">No expenses added yet.</p>
        `;
        return;
    }

    container.innerHTML = member.expenses.map((expense, idx) => {
        let splitText = '';
        if (expense.splitAmong && expense.splitAmong.length > 0 && expense.splitAmong.length !== trip.members.length) {
            const names = expense.splitAmong.map(i => trip.members[i]?.name || '').filter(Boolean);
            splitText = `<div class="expense-meta">👥 Split with: ${names.map(n => escapeHTML(n)).join(', ')}</div>`;
        }
        return `
            <div class="expense-item">
                <div class="expense-item-left">
                    <div class="expense-description">${escapeHTML(expense.description)}</div>
                    ${splitText}
                </div>
                <div class="expense-item-right">
                    <div class="expense-amount">${formatMoney(expense.amount, trip.currency)}</div>
                    <div class="expense-actions">
                        <button class="expense-edit-btn" onclick="editExpense(${idx})">✏️ Edit</button>
                        <button class="expense-delete-btn" onclick="deleteExpense(${idx})">🗑️</button>
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

/* =========================================================
   BACK NAV
========================================================= */

function backToMembers() {
    renderMemberSelection();
    showPage("memberSelectionPage");
}

function backToOngoingTrips() {
    renderOngoingTrips();
    showPage("ongoingTripsPage");
}

/* =========================================================
   COMPLETE TRIP
========================================================= */

async function completeTrip() {
    if (currentTripIndex === null || !ongoingTripsData[currentTripIndex]) return;

    const trip = ongoingTripsData[currentTripIndex];
    calculateTripSummary(trip);

    document.getElementById("endTripSection").style.display = "block";
    document.getElementById("summaryBackButton").style.display = "inline-block";
    document.getElementById("shareSummaryBtn").style.display = "inline-block";

    showPage("tripSummaryPage");
}

/* =========================================================
   BUILD SUMMARY (with custom splits)
========================================================= */

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

/* =========================================================
   SETTLEMENT FROM BALANCES
========================================================= */

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

function calculateSettlements(personTotals, equalShare) {
    return calculateSettlementsFromBalances(
        personTotals.map(p => ({ name: p.name, amount: p.spent - equalShare }))
    );
}

/* =========================================================
   CALCULATE / RENDER SUMMARY
========================================================= */

function calculateTripSummary(trip) {
    const summary = buildSummaryData(trip);
    trip.summary = JSON.parse(JSON.stringify(summary));
    renderSummary(trip, summary);
}

function renderSummary(trip, summary) {
    const cur = trip.currency || 'INR';

    document.getElementById("summaryDestination").textContent =
        trip.destination + " — Final Expense Summary";

    document.getElementById("summaryTotal").innerHTML = `
        <span>Total Money Spent</span>
        <strong>${formatMoney(summary.totalExpense, cur)}</strong>
    `;

    document.getElementById("summaryShare").innerHTML = `
        <span>Average per Person (Total ÷ ${trip.members.length})</span>
        <strong>${formatMoney(summary.equalShare, cur)}</strong>
    `;

    renderPersonSummary(summary.perPersonBalances || summary.personTotals, summary.equalShare, cur, summary);
    renderSettlements(summary.settlements, cur);
}

/* =========================================================
   PERSON SUMMARY
========================================================= */

function renderPersonSummary(balances, equalShare, currency, fullSummary) {
    const container = document.getElementById("personSummary");

    if (balances && balances[0] && typeof balances[0].balance !== 'undefined') {
        container.innerHTML = balances.map((person, idx) => {
            const balance = person.balance;
            let balanceHTML;
            if (balance > 0.005) {
                balanceHTML = `<div class="balance-positive">Gets back ${formatMoney(balance, currency)}</div>`;
            } else if (balance < -0.005) {
                balanceHTML = `<div class="balance-negative">Owes ${formatMoney(Math.abs(balance), currency)}</div>`;
            } else {
                balanceHTML = `<div style="color:#94a3b8;font-weight:700;">Settled</div>`;
            }
            const spent = person.spent;
            const owe = fullSummary && fullSummary.personOwe
                ? fullSummary.personOwe[idx]
                : equalShare;
            return `
                <div class="summary-person">
                    <div>
                        <div class="summary-person-name">${escapeHTML(person.name)}</div>
                        <div class="summary-person-spent">
                            Paid: ${formatMoney(spent, currency)}
                            ${fullSummary && fullSummary.personOwe ? ` • Their share: ${formatMoney(owe, currency)}` : ''}
                        </div>
                    </div>
                    ${balanceHTML}
                </div>
            `;
        }).join("");
    } else {
        container.innerHTML = balances.map(person => {
            const balance = person.spent - equalShare;
            let balanceHTML;
            if (balance > 0.005) {
                balanceHTML = `<div class="balance-positive">Gets back ${formatMoney(balance, currency)}</div>`;
            } else if (balance < -0.005) {
                balanceHTML = `<div class="balance-negative">Owes ${formatMoney(Math.abs(balance), currency)}</div>`;
            } else {
                balanceHTML = `<div style="color:#94a3b8;font-weight:700;">Settled</div>`;
            }
            return `
                <div class="summary-person">
                    <div>
                        <div class="summary-person-name">${escapeHTML(person.name)}</div>
                        <div class="summary-person-spent">Spent: ${formatMoney(person.spent, currency)}</div>
                    </div>
                    ${balanceHTML}
                </div>
            `;
        }).join("");
    }
}

/* =========================================================
   RENDER SETTLEMENTS
========================================================= */

function renderSettlements(settlements, currency) {
    const container = document.getElementById("settlementList");

    if (settlements.length === 0) {
        container.innerHTML = `<div class="settlement-item">✅ Everyone is settled!</div>`;
        return;
    }

    container.innerHTML = settlements.map(s => `
        <div class="settlement-item">
            <strong>${escapeHTML(s.from)}</strong> → <strong>${escapeHTML(s.to)}</strong>
            &nbsp; ${formatMoney(s.amount, currency)}
        </div>
    `).join("");
}

/* =========================================================
   SHARE SUMMARY (COPY)
========================================================= */

function shareSummary() {
    let trip, summary;
    const isPast = viewingPastTripIndex !== null && pastTripsData[viewingPastTripIndex];

    if (isPast) {
        trip = pastTripsData[viewingPastTripIndex];
        summary = trip.summary || buildSummaryData(trip);
    } else if (currentTripIndex !== null && ongoingTripsData[currentTripIndex]) {
        trip = ongoingTripsData[currentTripIndex];
        summary = trip.summary || buildSummaryData(trip);
    } else {
        return;
    }

    const cur = trip.currency || 'INR';
    const symbol = getCurrencySymbol(cur);

    let text = `🧳 TripSplit Summary — ${trip.destination}\n`;
    text += `📅 ${formatDate(trip.startDate)} → ${formatDate(trip.endDate)}\n`;
    if (isPast) text += `🏁 Completed trip\n`;
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

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => alert("✅ Summary copied to clipboard! You can now paste and share it."))
            .catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        alert("✅ Summary copied to clipboard!");
    } catch (e) {
        prompt("Copy this summary:", text);
    }
    document.body.removeChild(ta);
}

/* =========================================================
   END TRIP
========================================================= */

async function endTrip() {
    if (currentTripIndex === null || !ongoingTripsData[currentTripIndex]) return;

    const srcTrip = ongoingTripsData[currentTripIndex];
    const completedTrip = JSON.parse(JSON.stringify(srcTrip));
    completedTrip.summary = buildSummaryData(completedTrip);
    completedTrip.isCompleted = true;
    completedTrip.completedDate = new Date().toISOString();

    pastTripsData.push(completedTrip);
    if (pastTripsData.length > 50) pastTripsData.shift();

    ongoingTripsData.splice(currentTripIndex, 1);

    const remoteId = srcTrip._id;
    currentTripIndex = null;
    currentMemberIndex = null;
    editingTripIndex = null;
    viewingPastTripIndex = null;

    persistAll();

    if (remoteId) {
        try { await api('POST', `/${remoteId}/complete`); } catch (e) {}
    }

    showPage("menuPage");
}

/* =========================================================
   PAST TRIPS
========================================================= */

function showPastTrips() {
    renderPastTrips();
    showPage("pastTripsPage");
}

function renderPastTrips() {
    const container = document.getElementById("pastTripsList");

    if (pastTripsData.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📜</div>
                <h3>No Past Trips</h3>
                <p>Completed trips will appear here.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = pastTripsData.map((trip, index) => {
        const cur = trip.currency || 'INR';
        const total = trip.summary ? trip.summary.totalExpense : 0;
        return `
            <div class="trip-card past-trip-card" onclick="if(!event.target.closest('.delete-btn')) openPastTrip(${index})">
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
                    ${trip.members.map(member => `
                        <div class="small-member">${escapeHTML(member.name)}</div>
                    `).join("")}
                </div>
                <div style="margin-top:15px;color:#94a3b8;font-size:13px;">👆 Click to view expense calculations</div>
                <div class="trip-card-actions">
                    <button class="delete-btn" onclick="event.stopPropagation(); deletePastTrip(${index})">
                        🗑️ Delete
                    </button>
                </div>
            </div>
        `;
    }).join("");
}

/* =========================================================
   DELETE PAST TRIP
========================================================= */

async function deletePastTrip(index) {
    const trip = pastTripsData[index];
    if (!trip) return;

    if (!confirm(`Delete past trip to "${trip.destination}"? This cannot be undone.`)) return;

    const id = trip._id;
    pastTripsData.splice(index, 1);
    persistAll();

    if (viewingPastTripIndex === index) viewingPastTripIndex = null;
    else if (viewingPastTripIndex !== null && viewingPastTripIndex > index) viewingPastTripIndex--;

    renderPastTrips();

    if (id) {
        try { await api('DELETE', `/${id}`); } catch (e) {}
    }
}

/* =========================================================
   OPEN PAST TRIP
========================================================= */

function openPastTrip(index) {
    if (!pastTripsData[index]) return;

    viewingPastTripIndex = index;
    const trip = pastTripsData[index];

    if (!trip.summary) trip.summary = buildSummaryData(trip);

    renderSummary(trip, trip.summary);

    document.getElementById("endTripSection").style.display = "none";
    document.getElementById("summaryBackButton").style.display = "inline-block";
    document.getElementById("shareSummaryBtn").style.display = "inline-block";

    showPage("tripSummaryPage");
}

/* =========================================================
   BACK FROM SUMMARY
========================================================= */

function backFromSummary() {
    if (viewingPastTripIndex !== null) {
        viewingPastTripIndex = null;
        renderPastTrips();
        showPage("pastTripsPage");
        return;
    }

    if (currentTripIndex !== null) {
        renderMemberSelection();
        showPage("memberSelectionPage");
    } else {
        showPage("menuPage");
    }
}

/* =========================================================
   FORMAT DATE
========================================================= */

function formatDate(dateString) {
    if (!dateString) return "";
    const date = new Date(dateString + "T00:00:00");
    return date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
}

/* =========================================================
   ERROR / SUCCESS
========================================================= */

function showError(elementId, message) {
    const element = document.getElementById(elementId);
    if (!element) return;
    element.textContent = message;
    element.style.display = "block";
}

function showSuccess(elementId, message) {
    const element = document.getElementById(elementId);
    if (!element) return;
    element.textContent = message;
    element.style.display = "block";
}

function hideMessage(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
        element.style.display = "none";
        element.textContent = "";
    }
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
   INIT
========================================================= */

document.addEventListener('DOMContentLoaded', async () => {
    await fullLoad();
    api('GET', '/health').then((r) => {
        if (r && r.status === 'ok') {
            BACKEND_ONLINE = true;
            console.log('%c✅ TripSplit backend connected via MongoDB',
                'color:#22c55e;font-weight:bold;');
            console.log(`   Ongoing trips: ${r.stats.ongoingTrips}, Past trips: ${r.stats.pastTrips}`);
        }
    }).catch(() => {
        BACKEND_ONLINE = false;
        console.log('%cℹ️  TripSplit running in offline/localStorage mode.',
            'color:#eab308;font-weight:bold;');
        console.log('   Start the Express server with `npm start` to enable cloud sync.');
    });
});

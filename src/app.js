
// Choose storage backend: './storage.js' for chrome.storage, './storage-supabase.js' for Supabase
import { loadState, loadCachedState, saveStateDebounced, startPolling, fetchLatestState } from './storage-supabase.js';

const boardEl = document.getElementById('board');
const statsEl = document.getElementById('stats');
const dashboardTitleEl = document.getElementById('dashboardTitle');
const mainViewActionsEl = document.getElementById('mainViewActions');
const kraViewActionsEl = document.getElementById('kraViewActions');
const productivityViewActionsEl = document.getElementById('productivityViewActions');
const tplList = document.getElementById('tpl-list');
const tplSection = document.getElementById('tpl-section');
const tplTask = document.getElementById('tpl-task');
const toastEl = document.getElementById('toast');

let state = { lists: [], projects: [], employees: [], activity: [], bin: [], categories: [], kraTabs: [], activeKraTabId: null };
let toastTimer = null;
let activeListId = 'all';
let activeWorkspace = 'tasks';
let activeQuickPriority = 'any';
let activeQuickStatus = 'any';
let searchQuery = '';
let activeRegularEmployee = 'all';
let activeProjectEmployee = 'all';
let regularStartDate = firstDayOfMonth(new Date());
let attendanceMonth = firstDayOfMonth(new Date());
let calendarMonth = firstDayOfMonth(new Date());
let regularViewMode = 'grid';
let regularCalendarMonth = firstDayOfMonth(new Date());
let attendanceViewMode = 'grid';
// '__all__' == PRODUCTIVITY_ALL_EMPLOYEES, inlined since that const isn't
// declared until a couple of lines below this one.
let productivityEmployee = '__all__';
let productivityCategory = '';
let productivityFrom = '';
let productivityTo = '';
let productivitySortColumn = null;
let productivitySortDir = 'asc';
let productivityColumnFilters = {};
const PRODUCTIVITY_ALL_EMPLOYEES = '__all__';
let sidebarTasksExpanded = true;
let sidebarTabsExpanded = false;
let viewMode = loadViewMode();
const VIEW_MODES = new Set(['board', 'table', 'stack', 'calendar']);

// The Table/Stack/Calendar view switcher lives in .viewbar, which is
// hidden entirely at this width (no room for it) -- so whatever viewMode
// happened to be saved/defaulted is what mobile is stuck showing, with no
// way to change it. Table specifically is unusable that narrow. Horizontal
// (the card view) is the only one designed to work at this width, so it's
// forced regardless of the saved preference -- desktop's choice is left
// untouched in localStorage and comes back as soon as the viewport widens.
function isMobileViewport() {
  return window.innerWidth <= 768;
}

function loadViewMode() {
  try {
    // Bumped to v2 so browsers that already had "board" saved from before
    // the dense-table redesign pick up the new "table" default too,
    // instead of being stuck on their old preference forever.
    return localStorage.getItem('tikona_view_mode_v2') || 'table';
  } catch (err) {
    return 'table';
  }
}

function saveViewMode(mode) {
  try {
    localStorage.setItem('tikona_view_mode_v2', mode);
  } catch (err) {
    // View selection can still work for the current session if localStorage is unavailable.
  }
}

// Which employee this browser/device belongs to, for the checked-out access
// lock (see getAccessLockInfo/renderAccessLock) -- set the moment someone
// verifies their Google account in the Attendance popup, so the app can
// keep recognizing them across reloads without re-verifying every time.
// This is a workflow nudge, not real security: it's plain localStorage,
// clearable from the lock screen's own "Switch account" link or devtools.
const SIGNED_IN_EMAIL_KEY = 'tikona_signed_in_email_v1';

function getSignedInEmail() {
  try {
    return localStorage.getItem(SIGNED_IN_EMAIL_KEY) || null;
  } catch (err) {
    return null;
  }
}

function setSignedInEmail(email) {
  try {
    localStorage.setItem(SIGNED_IN_EMAIL_KEY, email);
  } catch (err) {
    // Non-fatal -- the lock just won't persist across reloads on this device.
  }
}

function clearSignedInEmail() {
  try {
    localStorage.removeItem(SIGNED_IN_EMAIL_KEY);
  } catch (err) {
    // Non-fatal.
  }
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function persist() {
  saveStateDebounced(state);
}

function showToast(message, undoFn) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = message;
  toastEl.appendChild(span);
  if (undoFn) {
    const btn = document.createElement('button');
    btn.textContent = 'Undo';
    btn.onclick = () => {
      undoFn();
      toastEl.classList.remove('show');
    };
    toastEl.appendChild(btn);
  }
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 6000);
}

function fireConfetti() {
  const colors = ['#1F4690', '#3A5BA0', '#FFA500', '#E68A00', '#6C8BC4', '#111827'];
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const count = 140;
  const particles = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.3,
    size: 5 + Math.random() * 5,
    color: colors[Math.floor(Math.random() * colors.length)],
    vx: (Math.random() - 0.5) * 3,
    vy: 2 + Math.random() * 3,
    rotation: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.3,
    shape: Math.random() < 0.5 ? 'rect' : 'circle',
  }));

  const duration = 3200;
  const start = performance.now();

  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.03;
      p.rotation += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
    if (elapsed < duration) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}

function showFatal(message, err) {
  console.error(message, err);
  toastEl.innerHTML = '';
  const span = document.createElement('span');
  const detail = err && (err.message || String(err));
  span.textContent = detail ? `${message} (${detail})` : message;
  toastEl.appendChild(span);
  toastEl.classList.add('show');
}

// Last-resort safety net: catch any error that slips past the try/catch
// blocks inside render()/event handlers (e.g. one thrown directly inside a
// DOM event listener callback, which try/catch inside render() cannot see)
// and surface it on screen instead of leaving the tab silently broken.
window.addEventListener('error', (event) => {
  showFatal('An unexpected error occurred.', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  showFatal('An unexpected error occurred.', event.reason);
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PRIORITY_ORDER = ['none', 'low', 'medium', 'high'];
// Why a deleted task/project was removed -- only asked for entries that had
// real progress on them (see renderDeleteReasonPicker); untagged or
// "no-longer-needed" deletions never count as wasted effort in the
// Productivity Waste score, only ones explicitly marked "abandoned" do.
const DELETE_REASONS = ['no-longer-needed', 'abandoned'];
const DELETE_REASON_LABELS = { 'no-longer-needed': 'No longer needed', abandoned: 'Abandoned' };
const PROGRESS_STEPS = [0, 25, 50, 75, 100];
const STATUS_OPTIONS = ['Pending', 'In Progress', 'Done'];

function normalizeStatusValue(status) {
  const match = STATUS_OPTIONS.find((opt) => opt.toLowerCase() === (status || '').trim().toLowerCase());
  return match || 'Pending';
}

function nextStatus(current) {
  const idx = STATUS_OPTIONS.indexOf(normalizeStatusValue(current));
  return STATUS_OPTIONS[(idx + 1) % STATUS_OPTIONS.length];
}

function statusSlug(status) {
  return `status-${normalizeStatusValue(status).toLowerCase().replace(/\s+/g, '-')}`;
}

// The progress gauge and the Status dropdown are two separate fields that
// can each be set independently (clicking the gauge, or editing Status in
// the popup) — without this, setting Status to "Done"/"In Progress" alone
// left the gauge visually empty since it only reflected the click-driven
// `progress` field. Take whichever of the two implies more progress.
function statusToProgress(status) {
  const normalized = normalizeStatusValue(status);
  if (normalized === 'Done') return 100;
  if (normalized === 'In Progress') return 50;
  return 0;
}

function itemDisplayProgress(item) {
  if (item.done) return 100;
  if (typeof item.progress === 'number' && item.progress > 0 && item.progress <= 100) {
    return item.progress;
  }
  return Math.max(
    typeof item.progress === 'number' ? item.progress : 0, 
    statusToProgress(item.status)
  );
}
const LIST_COLORS = ['#1F4690', '#3A5BA0', '#FFA500', '#0F2A5C', '#E68A00', '#6C8BC4', '#111827', '#C77400'];
const VIEW_META = {
  board: { label: 'Horizontal', icon: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="1" y="3" width="5" height="14" rx="1.5"/><rect x="7.5" y="3" width="5" height="14" rx="1.5"/><rect x="14" y="3" width="5" height="14" rx="1.5"/></svg>' },
  table: { label: 'Table', icon: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="1" y="2" width="18" height="16" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="1" y1="8" x2="19" y2="8" stroke="currentColor" stroke-width="1.6"/><line x1="1" y1="13" x2="19" y2="13" stroke="currentColor" stroke-width="1.6"/></svg>' },
  stack: { label: 'Stack', icon: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="2" y="2" width="16" height="4.5" rx="1.3"/><rect x="2" y="8" width="16" height="4.5" rx="1.3"/><rect x="2" y="14" width="16" height="4.5" rx="1.3"/></svg>' },
  calendar: { label: 'Calendar', icon: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="1.5" y="3" width="17" height="15" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="1.5" y1="7.5" x2="18.5" y2="7.5" stroke="currentColor" stroke-width="1.6"/></svg>' },
};

function listAccentColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return LIST_COLORS[hash % LIST_COLORS.length];
}

// Per-device card sizing (not synced to Supabase — this is a local display
// preference, not shared data) so a manually resized card keeps its size
// across reloads and re-renders instead of snapping back to the default.
const CARD_SIZE_KEY = 'tikona_card_sizes_v1';

function loadCardSizes() {
  try {
    return JSON.parse(localStorage.getItem(CARD_SIZE_KEY) || '{}');
  } catch (err) {
    return {};
  }
}

function saveCardSizes() {
  try {
    localStorage.setItem(CARD_SIZE_KEY, JSON.stringify(cardSizes));
  } catch (err) {
    // If localStorage is unavailable, sizes just won't persist — non-fatal.
  }
}

const cardSizes = loadCardSizes();

function makeResizable(el, key) {
  const saved = cardSizes[key];
  if (saved) {
    el.style.width = saved.width;
    el.style.height = saved.height;
  }
  let skippedInitial = false;
  const observer = new ResizeObserver(() => {
    if (!skippedInitial) { skippedInitial = true; return; }
    // A card removed from the DOM (every render() rebuilds the board from
    // scratch) fires one last callback reporting a collapsed 0-size box —
    // ignore that instead of overwriting the real saved size with garbage.
    if (el.offsetWidth < 20 || el.offsetHeight < 20) return;
    cardSizes[key] = { width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px` };
    saveCardSizes();
  });
  observer.observe(el);
}
const DEFAULT_REGULAR_TASKS = [];

const FILTER_PRIORITIES = ['any', 'none', 'low', 'medium', 'high'];
const FILTER_STATUSES = ['any', 'open', 'done', 'overdue'];

function fmtShort(ts) {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function formatCompletedDate(ts) {
  if (!ts) return '';
  const now = new Date();
  const completed = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfCompletedDay = new Date(completed.getFullYear(), completed.getMonth(), completed.getDate());
  const dayDiff = Math.round((startOfToday - startOfCompletedDay) / 86400000);
  if (dayDiff <= 0) return 'Completed today';
  if (dayDiff === 1) return 'Completed yesterday';
  if (dayDiff < 7) return `Completed ${dayDiff} days ago`;
  if (dayDiff < 14) return 'Completed last week';
  if (dayDiff < 30) return `Completed ${Math.floor(dayDiff / 7)} weeks ago`;
  return `Completed on ${fmtShort(ts)}`;
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  const hours = d.getHours();
  const h12 = ((hours + 11) % 12) + 1;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${fmtShort(ts)}, ${h12}:${mins} ${ampm}`;
}

function shortenDevice(ua) {
  if (!ua) return 'Unknown device';
  let browser = 'Unknown browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  let os = 'Unknown OS';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function firstDayOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonths(date, amount) {
  const next = new Date(date);
  const targetMonth = next.getMonth() + amount;
  next.setMonth(targetMonth);
  return next;
}

function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// `item` (the task/project, optional) drives the "+Nd" delay suffix: while
// still open and past due, N grows day by day (today vs. due date); once
// completed late, N freezes at however many days it actually took past the
// deadline (completedAt vs. due date) instead of continuing to climb.
function dueLabel(due, item) {
  if (!due) return { text: '', cls: '' };
  const today = todayStr();
  const [y, m, dd] = due.split('-').map(Number);
  const label = `Due ${MONTHS[m - 1]} ${dd}`;

  if (item && item.done) {
    if (item.completedAt) {
      const completedDay = dateKey(new Date(item.completedAt));
      const lateDays = productivityDateStrDiffDays(completedDay, due);
      if (lateDays > 0) return { text: `${label} (+${lateDays}d)`, cls: 'overdue-completed' };
    }
    return { text: label, cls: '' };
  }

  if (due < today) {
    const lateDays = productivityDateStrDiffDays(today, due);
    return { text: `Overdue ${MONTHS[m - 1]} ${dd} (+${lateDays}d)`, cls: 'overdue' };
  }
  if (due === today) return { text: 'Due today', cls: 'due-today' };
  return { text: label, cls: '' };
}

// ---------- data helpers ----------

function findList(listId) {
  return state.lists.find((l) => l.id === listId);
}

function sameEmployee(a, b) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

function normalizeState(value) {
  const lists = Array.isArray(value?.lists) ? value.lists : [];
  const kraTabs = normalizeKraTabs(value);
  const activeKraTabId =
    value?.activeKraTabId && kraTabs.some((t) => t.id === value.activeKraTabId)
      ? value.activeKraTabId
      : kraTabs[0]?.id || null;
  return {
    lists: lists.map((list) => ({
      id: list.id || uid('list'),
      name: list.name || 'Untitled list',
      ownerEmail: typeof list.ownerEmail === 'string' && list.ownerEmail ? list.ownerEmail.trim().toLowerCase() : null,
      sections: normalizeSections(list.sections),
      tasks: normalizeTasks(list.tasks),
      deletedTasks: normalizeDeletedTasks(list.deletedTasks),
      archived: Boolean(list.archived),
      archivedAt: list.archivedAt || null,
      mood: typeof list.mood === 'string' ? list.mood : 'neutral',
      description: typeof list.description === 'string' ? list.description : '',
    })),
    projects: normalizeProjects(value?.projects),
    regular: normalizeRegular(value?.regular),
    employees: normalizeRegisteredEmployees(value?.employees),
    activity: normalizeActivity(value?.activity),
    bin: normalizeBin(value?.bin),
    categories: normalizeCategories(value?.categories),
    chartsOrder: value?.chartsOrder || {},
    kraTabs,
    activeKraTabId,
  };
}

function normalizeKraWidgetsList(widgets) {
  if (!Array.isArray(widgets)) return [];
  return widgets
    .filter((w) => w && typeof w.url === 'string' && w.url.trim())
    .map((w) => ({
      id: w.id || uid('kra'),
      url: w.url.trim(),
      title: typeof w.title === 'string' ? w.title.trim() : '',
      viaProxy: Boolean(w.viaProxy),
    }));
}

// The Tabs section used to be a single flat grid of widgets (state.kraWidgets)
// before it grew separate named tabs/windows, each with its own grid. Any
// value saved under the old shape gets migrated into one "Home" tab instead
// of dropped, so real widgets users already added keep working.
function normalizeKraTabs(value) {
  if (Array.isArray(value?.kraTabs) && value.kraTabs.length) {
    return value.kraTabs
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        id: t.id || uid('kratab'),
        name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : 'Untitled',
        widgets: normalizeKraWidgetsList(t.widgets),
      }));
  }
  const legacyWidgets = normalizeKraWidgetsList(value?.kraWidgets);
  return [{ id: uid('kratab'), name: 'Home', widgets: legacyWidgets }];
}

function normalizeCategories(categories) {
  if (!Array.isArray(categories)) return [];
  const seen = new Set();
  const result = [];
  categories.forEach((c) => {
    const val = typeof c === 'string' ? c.trim() : '';
    if (val && !seen.has(val.toLowerCase())) {
      seen.add(val.toLowerCase());
      result.push(val);
    }
  });
  return result;
}

function normalizeBin(bin) {
  if (!Array.isArray(bin)) return [];
  return bin
    .filter((entry) => entry && entry.employee && typeof entry.employee.email === 'string')
    .map((entry) => ({
      id: entry.id || uid('bin'),
      exitedAt: Number.isFinite(entry.exitedAt) ? entry.exitedAt : Date.now(),
      employee: entry.employee,
      list: entry.list || null,
      projectMemberships: Array.isArray(entry.projectMemberships) ? entry.projectMemberships : [],
      regularTasks: Array.isArray(entry.regularTasks) ? entry.regularTasks : [],
      activity: Array.isArray(entry.activity) ? entry.activity : [],
    }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Real Google Sign-In for check-in/out, so only the actual employee behind
// that Google account can clock themselves in — not anyone clicking a name
// in a list. To turn this on:
//   1. Go to https://console.cloud.google.com/apis/credentials
//   2. Create an OAuth 2.0 Client ID of type "Web application".
//   3. Under "Authorized JavaScript origins" add the exact URL(s) this app
//      is served from (e.g. http://localhost:9080 while testing, and your
//      Vercel domain once deployed — https://your-app.vercel.app).
//   4. Paste the Client ID below.
// Until this is set, the Attendance popup falls back to the old
// no-verification flow so the app still works during setup/testing.
const GOOGLE_CLIENT_ID = '980610211732-8qtkobem4tg6phpv7ub8hv1stk4k2pqu.apps.googleusercontent.com';

function isGoogleSignInConfigured() {
  return Boolean(GOOGLE_CLIENT_ID) && typeof google !== 'undefined' && google.accounts?.id;
}

// Verifies the ID token with Google's own servers (not just decoding it
// locally) so a forged/tampered token can't be used to check in as someone
// else. Returns the verified, Google-confirmed email, or null if invalid.
async function verifyGoogleIdToken(idToken) {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return null;
    const payload = await res.json();
    if (payload.aud !== GOOGLE_CLIENT_ID) return null;
    if (payload.email_verified !== 'true' && payload.email_verified !== true) return null;
    if (!payload.email) return null;
    return payload.email.toLowerCase();
  } catch (err) {
    return null;
  }
}

function normalizeRegisteredEmployees(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e.email === 'string' && EMAIL_RE.test(e.email.trim()))
    .map((e) => ({
      name: typeof e.name === 'string' ? e.name.trim() : '',
      email: e.email.trim().toLowerCase(),
      joiningDate: typeof e.joiningDate === 'string' ? e.joiningDate : '',
      endDate: typeof e.endDate === 'string' ? e.endDate : '',
      registeredAt: Number.isFinite(e.registeredAt) ? e.registeredAt : Date.now(),
    }));
}

// Board-message-style entries (see logBoardEvent) aren't tied to an
// employee, so unlike register/checkin/checkout/leave/exit they're exempt
// from the "must have a real email" requirement, and carry a plain `text`
// field instead of being built from name+verb.
const ACTIVITY_MESSAGE_TYPES = ['announcement', 'task_created', 'project_created', 'due_changed', 'task_edited', 'project_edited', 'task_deleted', 'task_restored', 'task_completed', 'project_completed', 'regular_completed'];

function normalizeActivity(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.type === 'string' && (ACTIVITY_MESSAGE_TYPES.includes(a.type) || typeof a.email === 'string'))
    .map((a) => {
      const allTypes = ['register', 'checkin', 'checkout', 'leave', 'exit', 'employee_restored', 'share_copied', ...ACTIVITY_MESSAGE_TYPES];
      const type = allTypes.includes(a.type) ? a.type : 'checkin';
      const entry = {
        id: a.id || uid('act'),
        type,
        name: typeof a.name === 'string' ? a.name : '',
        email: typeof a.email === 'string' ? a.email : '',
        timestamp: Number.isFinite(a.timestamp) ? a.timestamp : Date.now(),
        ip: typeof a.ip === 'string' ? a.ip : '',
        device: typeof a.device === 'string' ? a.device : '',
      };
      if (type === 'leave') entry.leaveDates = Array.isArray(a.leaveDates) ? a.leaveDates : [];
      if (type === 'checkin') entry.workMode = a.workMode === 'WFH' || a.workMode === 'WFO' ? a.workMode : '';
      if (ACTIVITY_MESSAGE_TYPES.includes(type)) entry.text = typeof a.text === 'string' ? a.text : '';
      return entry;
    });
}

// Whoever this device is currently bound to (see SIGNED_IN_EMAIL_KEY /
// getAccessLockInfo) -- the best available signal for "who is doing this,"
// since it's the same Google-verified identity the access lock itself
// relies on. Falls back to their raw email if they're not (or no longer)
// a registered employee (e.g. the admin), and to null if this device has
// never verified anyone here -- there's genuinely nothing to attribute to
// in that case, so logBoardEvent leaves the fact unattributed rather than
// guessing.
function currentActorLabel() {
  const email = getSignedInEmail();
  if (!email) return null;
  const emp = getRegisteredEmployees().find((e) => e.email === email);
  return emp ? emp.name : email;
}

// Shared by task-created/project-created/due-date-changed/etc notice-board
// entries -- same shape as postAnnouncement's, just without a persist()/
// render() of its own, since every caller already does one right after
// (this only ever runs partway through an existing save, not standalone).
// Attributes to currentActorLabel() when this device has a known identity
// bound to it; otherwise logs the same bare fact as before.
function logBoardEvent(type, text) {
  state.activity = state.activity || [];
  const actor = currentActorLabel();
  state.activity.push({ id: uid('act'), type, text: actor ? `${text} — by ${actor}` : text, name: '', email: '', timestamp: Date.now(), ip: '', device: '' });
}

function postAnnouncement(text) {
  const clean = text.trim();
  if (!clean) return;
  state.activity = state.activity || [];
  state.activity.push({ id: uid('act'), type: 'announcement', text: clean, name: '', email: '', timestamp: Date.now(), ip: '', device: '' });
  persist();
  render();
}

function deleteAnnouncement(id) {
  state.activity = (state.activity || []).filter((a) => a.id !== id);
  persist();
  render();
}

function normalizeProjects(projects) {
  if (!Array.isArray(projects)) return [];
  return projects.map((project) => {
    const owners = Array.isArray(project.owners) && project.owners.length
      ? project.owners.filter((o) => typeof o === 'string' && o.trim())
      : (project.owner && project.owner !== 'Unassigned' ? [project.owner] : []);
    return {
      id: project.id || uid('proj'),
      name: project.name || 'Untitled project',
      owner: owners[0] || 'Unassigned',
      owners,
      description: typeof project.description === 'string' ? project.description : '',
      startDate: project.startDate || null,
      dueDate: project.dueDate || null,
      priority: PRIORITY_ORDER.includes(project.priority) ? project.priority : 'none',
      status: typeof project.status === 'string' ? project.status : '',
      sections: normalizeSections(project.sections),
      tasks: normalizeTasks(project.tasks),
      archived: Boolean(project.archived),
      archivedAt: project.archivedAt || null,
      deleted: Boolean(project.deleted),
      deletedAt: project.deletedAt || null,
      deleteReason: DELETE_REASONS.includes(project.deleteReason) ? project.deleteReason : null,
      mood: typeof project.mood === 'string' ? project.mood : 'neutral',
      done: Boolean(project.done),
      completedAt: Number.isFinite(project.completedAt) ? project.completedAt : null,
      progress: (typeof project.progress === 'number' && project.progress >= 0 && project.progress <= 100) ? project.progress : 0,
      category: typeof project.category === 'string' ? project.category : '',
    };
  });
}

const COMPLETION_RETENTION_DAYS = 120;

// chrome.storage.sync caps each stored item at 8KB. state.regular.completions
// grows without bound as boxes get checked over months, so drop entries
// older than the retention window to keep saves from silently failing once
// the item crosses the quota.
function pruneOldCompletions(completions) {
  const cutoff = dateKey(addDays(new Date(), -COMPLETION_RETENTION_DAYS));
  const pruned = {};
  Object.keys(completions).forEach((key) => {
    const datePart = key.split(':').pop();
    if (datePart >= cutoff) pruned[key] = completions[key];
  });
  return pruned;
}

function normalizeRegular(regular) {
  const sourceTasks = Array.isArray(regular?.tasks) ? regular.tasks : [];
  const tasks = sourceTasks.map((task) => ({
    id: task.id || uid('reg'),
    cadence: CADENCE_OPTIONS.includes(task.cadence) ? task.cadence : 'daily',
    owner: task.owner || 'Unassigned',
    title: task.title || 'Untitled regular task',
    time: task.time || '',
    group: task.group === 'Research - Daily' ? 'Daily' : (task.group || cadenceLabel(task.cadence || 'daily')),
    category: typeof task.category === 'string' ? task.category : '',
    priority: PRIORITY_ORDER.includes(task.priority) ? task.priority : 'none',
    weekday: Number.isInteger(task.weekday) ? task.weekday : 1,
    dayOfMonth: Number.isInteger(task.dayOfMonth) ? task.dayOfMonth : 1,
    month: Number.isInteger(task.month) ? task.month : 0,
    monthlyMode: task.monthlyMode === 'weekday' ? 'weekday' : 'date',
    weekdayOrdinal: Number.isInteger(task.weekdayOrdinal) ? Math.min(5, Math.max(1, task.weekdayOrdinal)) : 1,
  }));
  const employees = [...new Set(tasks.map((task) => task.owner))].sort();
  const rawCompletions = regular?.completions && typeof regular.completions === 'object' ? regular.completions : {};
  const completions = pruneOldCompletions(rawCompletions);
  const columns = Array.isArray(regular?.columns) && regular.columns.length
    ? regular.columns.map((key, index) => {
      if (typeof key === 'string' && key.split('-').length === 3) return key;
      if (typeof key === 'number') return dateKey(addDays(firstDayOfMonth(new Date()), key));
      if (typeof key === 'string' && /^\?\d+$/.test(key)) return dateKey(addDays(firstDayOfMonth(new Date()), Number(key)));
      return dateKey(addDays(firstDayOfMonth(new Date()), index));
    })
    : Array.from({ length: daysInMonth(regularStartDate) }, (_, index) => dateKey(addDays(regularStartDate, index)));
  return { tasks, employees, completions, columns };
}

function normalizeSections(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.map((section) => ({
    id: section.id || uid('sec'),
    name: section.name || 'Untitled section',
    collapsed: Boolean(section.collapsed),
  }));
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((task) => ({
    id: task.id || uid('task'),
    text: task.text || 'Untitled task',
    priority: PRIORITY_ORDER.includes(task.priority) ? task.priority : 'none',
    due: typeof task.due === 'string' ? task.due : null,
    startDate: typeof task.startDate === 'string' ? task.startDate : null,
    createdAt: Number.isFinite(task.createdAt) ? task.createdAt : Date.now(),
    completedAt: Number.isFinite(task.completedAt) ? task.completedAt : null,
    done: Boolean(task.done),
    status: typeof task.status === 'string' ? task.status : '',
    sectionId: typeof task.sectionId === 'string' ? task.sectionId : null,
    dueChangeCount: Number.isFinite(task.dueChangeCount) ? task.dueChangeCount : 0,
    assignedTo: typeof task.assignedTo === 'string' ? task.assignedTo : '',
    mood: typeof task.mood === 'string' ? task.mood : 'neutral',
    description: typeof task.description === 'string' ? task.description : '',
    progress: (typeof task.progress === 'number' && task.progress >= 0 && task.progress <= 100) ? task.progress : 0,
    category: typeof task.category === 'string' ? task.category : '',
  }));
}

const DELETED_TASKS_RETENTION = 50;

function normalizeDeletedTasks(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && e.task)
    .map((e) => ({
      id: e.id || uid('del'),
      task: e.task,
      deletedAt: Number.isFinite(e.deletedAt) ? e.deletedAt : Date.now(),
      reason: DELETE_REASONS.includes(e.reason) ? e.reason : null,
    }))
    .slice(0, DELETED_TASKS_RETENTION);
}

function formatDateStrForShare(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// 4 PM is the hard line the copy-status icon resets on (see
// renderListCopyStatusIcon) and the point the WhatsApp update flips from a
// morning briefing (today's focus) to an evening one (tomorrow's focus +
// what got finished today).
const COPY_STATUS_RESET_HOUR = 16;

function isEveningUpdateWindow(date = new Date()) {
  return date.getHours() >= COPY_STATUS_RESET_HOUR;
}

// Compact plain-text "water-fill" bar standing in for the app's status
// pill -- WhatsApp can't render the real gradient-fill pill, so this is
// the closest text-only equivalent: filled segments + the exact percent.
// (Still used by buildSingleItemShareText, the per-row copy icon.)
function progressFillBar(percent) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(pct / 20);
  return `${'▰'.repeat(filled)}${'▱'.repeat(5 - filled)} ${pct}%`;
}

const REPORT_PRIORITY_EMOJI = { high: '🔴', medium: '🟠', low: '🔵', none: '⚪' };
const REPORT_MOOD_EMOJI = { happy: '🤩', neutral: '😐', sad: '🥱', busy: '😎' };
const REPORT_MOOD_LABELS = { happy: 'Happy', neutral: 'Neutral', sad: 'Low', busy: 'Busy' };
const REPORT_PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1, none: 0 };
const REPORT_WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Sorts a task/project (already-open, not yet claimed by Focus) into
// exactly one bucket instead of letting it repeat across several -- due on
// the target date wins first (the whole point of a Focus section), then a
// serious delay (>2 days overdue), then generic progress state. `today` is
// always the real current date even when targetDateStr is tomorrow's (the
// evening report), since a delay is always relative to now, not to
// whichever day Focus happens to be looking at.
function classifyReportItems(items, targetDateStr) {
  const today = todayStr();
  const focus = [], highDelay = [], inProgress = [], yetToStart = [];
  items.forEach((item) => {
    if (item.done) return;
    if (item.due && item.due === targetDateStr) { focus.push(item); return; }
    if (item.due && item.due < today) {
      const lateDays = productivityDateStrDiffDays(today, item.due);
      if (lateDays > 2) { highDelay.push({ ...item, lateDays }); return; }
    }
    if (item.progress > 0 && item.progress < 100) { inProgress.push(item); return; }
    yetToStart.push(item);
  });
  return { focus, highDelay, inProgress, yetToStart };
}

// Pads `text` with `char` on both sides to visually center it -- WhatsApp
// has no real text-align, this is the usual plain-text trick.
function centerPad(text, char, width) {
  const padLen = Math.max(0, width - text.length);
  const left = Math.floor(padLen / 2);
  const right = padLen - left;
  return `${char.repeat(left)}${text}${char.repeat(right)}`;
}

function reportSectionHeader(emoji, text, count) {
  const decorated = centerPad(`${text} (${String(count).padStart(2, '0')})`, '-', 28);
  return emoji ? `${emoji} *${decorated}*` : `*${decorated}*`;
}

function reportSubLabel(label) {
  return `_${centerPad(label, '-', 24)}_`;
}

// WhatsApp text has no font color, only bold/italic/strikethrough -- an
// overdue date is bolded (as close to "flagged" as plain text gets, true
// red isn't possible). TDY/TMW for today/tomorrow, "ND (Wkd DDMON)" inside
// a week, otherwise just "DDth MON".
function reportDueBits(dueStr) {
  if (!dueStr) return null;
  const diffDays = productivityDateStrDiffDays(dueStr, todayStr());
  if (diffDays < 0) return { text: `${Math.abs(diffDays)}D OVERDUE`, bold: true };
  if (diffDays === 0) return { text: 'TDY', bold: false };
  if (diffDays === 1) return { text: 'TMW', bold: false };
  const d = new Date(`${dueStr}T00:00:00`);
  if (diffDays <= 7) {
    return { text: `${diffDays}D (${WEEKDAYS[d.getDay()]} ${d.getDate()}${MONTHS[d.getMonth()].toUpperCase()})`, bold: false };
  }
  return { text: `${ordinal(d.getDate())} ${MONTHS[d.getMonth()].toUpperCase()}`, bold: false };
}

function reportItemLine(item) {
  const emoji = REPORT_PRIORITY_EMOJI[item.priority] || REPORT_PRIORITY_EMOJI.none;
  const due = reportDueBits(item.due);
  const dueText = due ? (due.bold ? `*Due: ${due.text}*` : `Due: ${due.text}`) : '';
  return `${emoji} *${item.text}*\n${Math.round(item.progress)}%${dueText ? `| ${dueText}` : ''}`;
}

// Appends a section only if it actually has something in it -- an empty
// "(0)" section with nothing under it is just noise in a report this dense.
// `groups` is [{ label, items }, ...] -- e.g. Regular Task/Task/Project --
// so items from different sources are told apart instead of sitting in one
// unlabeled flat list; a group with nothing in it is skipped too.
function pushReportSection(lines, emoji, headerText, groups) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) return;
  lines.push(reportSectionHeader(emoji, headerText, total));
  let firstGroup = true;
  groups.forEach((g) => {
    if (!g.items.length) return;
    if (!firstGroup) lines.push('');
    firstGroup = false;
    lines.push(reportSubLabel(g.label));
    g.items.forEach((l) => lines.push(l));
  });
  lines.push('');
}

function bucketByKind(items) {
  return { task: items.filter((i) => i.kind === 'task'), project: items.filter((i) => i.kind === 'project') };
}

function buildDailyUpdateShareText(list) {
  const evening = isEveningUpdateWindow();
  const todayDate = new Date();
  const targetDate = evening ? addDays(todayDate, 1) : todayDate;
  const targetDateStr = dateKey(targetDate);

  const emp = getRegisteredEmployees().find((e) => sameEmployee(e.name, list.name));
  const checkin = emp ? getLatestTodayActivity(emp.email, 'checkin') : null;
  const checkout = emp ? getLatestTodayActivity(emp.email, 'checkout') : null;
  const moodEmoji = REPORT_MOOD_EMOJI[list.mood] || REPORT_MOOD_EMOJI.neutral;
  const moodLabel = REPORT_MOOD_LABELS[list.mood] || REPORT_MOOD_LABELS.neutral;
  const inTime = checkin ? fmtTimeOnly(checkin.timestamp) : '—';
  const outTime = checkout ? fmtTimeOnly(checkout.timestamp) : '—';
  const workMode = (checkin && checkin.workMode) || '—';

  // Task + Project share one normalized shape (progress/due/done/priority)
  // so they can be classified and rendered identically, tagged with `kind`
  // so each section can still tell them apart when rendering. Regular
  // Tasks are handled on their own below -- recurring/binary (done-today
  // or not), with no due date or partial progress of their own to
  // classify by, so they only ever land in Focus or Completed.
  const taskItems = (list.tasks || [])
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((t) => ({
      kind: 'task', text: t.text, priority: t.priority || 'none', due: t.due || null,
      done: Boolean(t.done), completedAt: t.completedAt || null,
      progress: itemDisplayProgress(t),
    }));
  const ownedProjects = (state.projects || []).filter((p) => !p.deleted && !p.archived && (p.owners || []).some((o) => sameEmployee(o, list.name)));
  const projectItems = ownedProjects.map((p) => ({
    kind: 'project', text: p.name, priority: p.priority || 'none', due: p.dueDate || null,
    done: Boolean(p.done), completedAt: p.completedAt || null,
    progress: itemDisplayProgress(p),
  }));
  const allItems = [...taskItems, ...projectItems];

  const { focus, highDelay, inProgress, yetToStart } = classifyReportItems(allItems.filter((i) => !i.done), targetDateStr);
  inProgress.sort((a, b) => b.progress - a.progress);
  yetToStart.sort((a, b) => (REPORT_PRIORITY_WEIGHT[b.priority] || 0) - (REPORT_PRIORITY_WEIGHT[a.priority] || 0));
  highDelay.sort((a, b) => b.lateDays - a.lateDays);

  const regularOwned = (state.regular?.tasks || []).filter((t) => sameEmployee(t.owner, list.name));
  const regularExpectedTarget = regularOwned.filter((t) => isRegularTaskExpected(t, targetDate));
  // Tomorrow's Focus can't filter by "done" -- tomorrow hasn't happened yet.
  const regularFocus = evening ? regularExpectedTarget : regularExpectedTarget.filter((t) => !isRegularDone(t, todayDate));
  const regularFocusLines = regularFocus.map((t) => reportItemLine({ text: t.title, priority: t.priority, due: targetDateStr, progress: 0 }));

  const lines = [];
  lines.push(evening ? 'Good Evening !' : 'Good Morning !');
  lines.push(evening ? 'My Achievements for today' : 'I am Achieving for today');
  lines.push(`${REPORT_WEEKDAYS_FULL[todayDate.getDay()]}, ${ordinal(todayDate.getDate())} ${MONTHS[todayDate.getMonth()]} ${todayDate.getFullYear()}`);
  lines.push('');
  lines.push(`${moodEmoji} My Mood: ${moodLabel}`);
  lines.push(`${list.name} | ${workMode} | ${inTime}${evening ? ` | ${outTime}` : ''}`);
  lines.push('');

  // Evening leads with what got finished today, then looks ahead to
  // tomorrow's focus -- morning has nothing finished yet to lead with, so
  // it goes straight into today's focus. Regular Task listed first within
  // a section (ahead of Task/Project), per request.
  if (evening) {
    const today = todayStr();
    const completedTasks = taskItems.filter((i) => i.done && i.completedAt && dateKey(new Date(i.completedAt)) === today)
      .map((item) => { const score = productivityRowScore(item); return `✅ *${item.text}* — ${Number.isFinite(score) ? score : 0}/100 pts`; });
    const completedProjects = projectItems.filter((i) => i.done && i.completedAt && dateKey(new Date(i.completedAt)) === today)
      .map((item) => { const score = productivityRowScore(item); return `✅ *${item.text}* — ${Number.isFinite(score) ? score : 0}/100 pts`; });
    const completedRegular = regularOwned.filter((t) => isRegularTaskExpected(t, todayDate) && isRegularDone(t, todayDate))
      .map((t) => `✅ *${t.title}*`);
    pushReportSection(lines, '✅', 'COMPLETED TODAY', [
      { label: 'Regular Task', items: completedRegular },
      { label: 'Task', items: completedTasks },
      { label: 'Project', items: completedProjects },
    ]);
  }

  const focusByKind = bucketByKind(focus);
  pushReportSection(lines, '🎯', evening ? "TOMORROW'S FOCUS" : "TODAY'S FOCUS", [
    { label: 'Regular Task', items: regularFocusLines },
    { label: 'Task', items: focusByKind.task.map((item) => reportItemLine(item)) },
    { label: 'Project', items: focusByKind.project.map((item) => reportItemLine(item)) },
  ]);

  const inProgressByKind = bucketByKind(inProgress);
  pushReportSection(lines, '⚡', 'WIP & QUICK WINS', [
    { label: 'Task', items: inProgressByKind.task.map((item) => reportItemLine(item)) },
    { label: 'Project', items: inProgressByKind.project.map((item) => reportItemLine(item)) },
  ]);

  const highDelayByKind = bucketByKind(highDelay);
  pushReportSection(lines, '', 'HIGH DELAY TASKS', [
    { label: 'Task', items: highDelayByKind.task.map((item) => reportItemLine(item)) },
    { label: 'Project', items: highDelayByKind.project.map((item) => reportItemLine(item)) },
  ]);

  const yetToStartByKind = bucketByKind(yetToStart);
  pushReportSection(lines, '🚧', 'YET TO START', [
    { label: 'Task', items: yetToStartByKind.task.map((item) => reportItemLine(item)) },
    { label: 'Project', items: yetToStartByKind.project.map((item) => reportItemLine(item)) },
  ]);

  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// Same compact style as one line of buildDailyUpdateShareText, but for
// copying a single task/project on its own (the per-row copy icon) rather
// than a whole card's worth of updates.
function buildSingleItemShareText(item, isProjectItem = false) {
  const priorityEmoji = { high: '🔴', medium: '🟠', low: '🔵', none: '⚪' };
  const name = isProjectItem ? item.name : item.text;
  const dueText = formatDateStrForShare(isProjectItem ? item.dueDate : item.due);
  if (item.done) {
    const score = productivityRowScore(item);
    return `✅ *${name}* — ${Number.isFinite(score) ? score : 0}/100 pts${dueText ? ` | Due: ${dueText}` : ''}`;
  }
  const priority = item.priority || 'none';
  const lines = [`${priorityEmoji[priority] || priorityEmoji.none} *${name}*`];
  lines.push(`${progressFillBar(itemDisplayProgress(item))}${dueText ? ` | Due: ${dueText}` : ''}`);
  return lines.join('\n');
}

function buildProjectsShareText(name, projects) {
  const priorityEmoji = { high: '🔴', medium: '🟠', low: '🔵', none: '⚪' };
  const items = (projects || []).filter((p) => !p.done);

  const lines = [`📋 *${name}* — Projects`, ''];
  if (!items.length) {
    lines.push('_No active projects._');
  } else {
    items.forEach((project, i) => {
      lines.push(`${i + 1}. 📁 *${project.name}*`);
      const priority = project.priority || 'none';
      const meta = [`${priorityEmoji[priority] || priorityEmoji.none} ${priority.charAt(0).toUpperCase()}${priority.slice(1)}`];
      if (project.category) meta.push(`🏷 ${project.category}`);
      lines.push(`   ${meta.join('   ')}`);
      const statusLine = [`Status: ${project.status || 'Pending'}`];
      const dueText = formatDateStrForShare(project.dueDate);
      if (dueText) statusLine.push(`Due: ${dueText}`);
      lines.push(`   ${statusLine.join('   |   ')}`);
      lines.push('');
    });
  }
  lines.push(`_Active: ${items.length}_`);
  return lines.join('\n');
}

function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
  return Promise.resolve();
}

function getActiveLists() {
  return state.lists.filter((l) => !l.archived);
}

function getArchivedLists() {
  return state.lists.filter((l) => l.archived);
}

function getVisibleLists() {
  const active = getActiveLists();
  if (activeListId === 'all') return active;
  const selected = findList(activeListId);
  return selected && !selected.archived ? [selected] : active;
}

function getArchivedProjects() {
  return (state.projects || []).filter((p) => p.archived);
}

function getProjectEmployees() {
  const names = new Set();
  (state.projects || []).forEach((project) => (project.owners || []).forEach((o) => names.add(o)));
  return [...names].sort();
}

function listTaskStats(list) {
  const open = list.tasks.filter((t) => !t.done).length;
  const done = list.tasks.filter((t) => t.done).length;
  const overdue = list.tasks.filter((t) => !t.done && t.due && t.due < todayStr()).length;
  return { open, done, overdue, total: list.tasks.length };
}

function getActiveFilter() {
  if (activeQuickPriority === 'any' && activeQuickStatus === 'any') return null;
  return { priority: activeQuickPriority, status: activeQuickStatus };
}

function taskMatchesFilter(task, filter) {
  if (!filter) return true;
  if (filter.priority !== 'any' && (task.priority || 'none') !== filter.priority) return false;
  if (filter.status === 'open' && task.done) return false;
  if (filter.status === 'done' && !task.done) return false;
  if (filter.status === 'overdue' && !(!task.done && task.due && task.due < todayStr())) return false;
  return true;
}

function taskMatchesSearch(task) {
  if (!searchQuery) return true;
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  return (task.text || '').toLowerCase().includes(q)
    || (task.description || '').toLowerCase().includes(q)
    || (task.status || '').toLowerCase().includes(q)
    || (task.assignedTo || '').toLowerCase().includes(q);
}

function filterTasks(tasks) {
  const filter = getActiveFilter();
  return tasks.filter((task) => taskMatchesFilter(task, filter) && taskMatchesSearch(task));
}

function getAllTaskRowsUnfiltered(includeDone = true) {
  return getVisibleLists().flatMap((list) => {
    const sections = new Map((list.sections || []).map((section) => [section.id, section.name]));
    return list.tasks
      .filter((task) => includeDone || !task.done)
      .map((task) => ({
        list,
        task,
        sectionName: task.sectionId ? sections.get(task.sectionId) || 'Section' : 'Unsectioned',
      }));
  });
}

function getAllTaskRows(includeDone = true) {
  const filter = getActiveFilter();
  return getAllTaskRowsUnfiltered(includeDone).filter(({ task }) => taskMatchesFilter(task, filter) && taskMatchesSearch(task));
}

const CADENCE_OPTIONS = ['daily', 'weekly', 'monthly', 'quarterly', 'half-yearly', 'yearly'];

function cadenceLabel(cadence) {
  if (cadence === 'daily') return 'Daily';
  if (cadence === 'weekly') return 'Weekly';
  if (cadence === 'monthly') return 'Monthly';
  if (cadence === 'quarterly') return 'Quarterly';
  if (cadence === 'half-yearly') return 'Half-yearly';
  if (cadence === 'yearly') return 'Yearly';
  return 'Monthly';
}

function getRegularTasks() {
  const tasks = state.regular?.tasks || [];
  if (activeRegularEmployee === 'all') return tasks;
  return tasks.filter((task) => sameEmployee(task.owner, activeRegularEmployee));
}

function getRegularDates() {
  const columnKeys = state.regular?.columns || [];
  if (columnKeys.length) {
    return columnKeys.map((key) => {
      const [year, month, day] = key.split('-').map(Number);
      return new Date(year, month - 1, day);
    });
  }
  return Array.from({ length: daysInMonth(regularStartDate) }, (_, index) => addDays(regularStartDate, index));
}

function addRegularTask() {
  const owner = activeRegularEmployee !== 'all' ? activeRegularEmployee : 'Unassigned';
  const task = {
    id: uid('reg'),
    cadence: 'daily',
    owner,
    title: 'New regular task',
    time: '09:00',
    group: 'Daily',
    weekday: 1,
    dayOfMonth: 1,
    priority: 'none',
  };
  state.regular.tasks.push(task);
  refreshRegularEmployees();
  persist();
  render();
}

// Add a task with supplied details (used by prompt flow)
function addRegularTaskWith(details = {}) {
  const owner = details.owner || (activeRegularEmployee !== 'all' ? activeRegularEmployee : 'Unassigned');
  const cadence = details.cadence || 'daily';
  const task = {
    id: uid('reg'),
    cadence,
    owner,
    title: details.title || 'New regular task',
    time: details.time || '',
    group: details.group || cadenceLabel(cadence),
    category: details.category || '',
    priority: PRIORITY_ORDER.includes(details.priority) ? details.priority : 'none',
    weekday: Number.isInteger(details.weekday) ? details.weekday : 1,
    dayOfMonth: Number.isInteger(details.dayOfMonth) ? details.dayOfMonth : 1,
    month: Number.isInteger(details.month) ? details.month : 0,
    monthlyMode: details.monthlyMode === 'weekday' ? 'weekday' : 'date',
    weekdayOrdinal: Number.isInteger(details.weekdayOrdinal) ? Math.min(5, Math.max(1, details.weekdayOrdinal)) : 1,
  };
  // insert into tasks array; if details.insertAfterId provided, place after that task
  if (details.insertAfterId) {
    const idx = state.regular.tasks.findIndex((t) => t.id === details.insertAfterId);
    if (idx === -1) state.regular.tasks.push(task);
    else state.regular.tasks.splice(idx + 1, 0, task);
  } else if (details.insertAtIndex != null && Number.isInteger(details.insertAtIndex)) {
    state.regular.tasks.splice(Math.max(0, details.insertAtIndex), 0, task);
  } else {
    state.regular.tasks.push(task);
  }
  refreshRegularEmployees();
  persist();
  render();
}

// Shared shell for the small regular-tasks popups (add/remove row/column).
function openRegularPopup(title, bodyHtml, { confirmLabel = 'Save', danger = false } = {}) {
  document.querySelectorAll('.regular-popup-overlay').forEach((m) => m.remove());

  const overlay = document.createElement('div');
  overlay.className = 'regular-popup-overlay';

  const popup = document.createElement('div');
  popup.innerHTML = `
    <h2 style="margin:0 0 12px 0;font-size:17px;font-weight:600;">${title}</h2>
    ${bodyHtml}
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
      <button type="button" id="regPopupCancel" style="padding:8px 20px;border:1px solid #ddd;border-radius:999px;background:white;cursor:pointer;font-size:13.5px;font-weight:500;">Cancel</button>
      <button type="button" id="regPopupConfirm" style="padding:8px 20px;border:none;border-radius:999px;background:${danger ? '#E04858' : '#FFA500'};color:white;cursor:pointer;font-size:13.5px;font-weight:600;">${confirmLabel}</button>
    </div>
  `;
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  popup.querySelector('#regPopupCancel').addEventListener('click', () => overlay.remove());

  return { overlay, popup, confirmBtn: popup.querySelector('#regPopupConfirm') };
}

const FIELD_STYLE = 'width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;';
const FIELD_LABEL_STYLE = 'display:block;margin-bottom:4px;font-weight:500;font-size:13px;';

// ---------- employee registration & check-in/out ----------

function getRegisteredEmployees() {
  return state.employees || [];
}

function isEmailRegistered(email) {
  return getRegisteredEmployees().some((e) => e.email === email.trim().toLowerCase());
}

async function fetchClientIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    return data.ip || 'Unknown';
  } catch (err) {
    return 'Unknown';
  }
}

function logActivity(type, email, ip, device, name = '', extra = {}) {
  state.activity = state.activity || [];
  state.activity.push({ id: uid('act'), type, name, email, timestamp: Date.now(), ip, device, ...extra });
  persist();
  render();
}

function openRegisterPopup() {
  const today = todayStr();
  const configured = isGoogleSignInConfigured();
  const { overlay, popup, confirmBtn } = openRegularPopup('Register Employee', `
    <div class="popup-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div>
        <label style="${FIELD_LABEL_STYLE}">Full name *</label>
        <input type="text" id="registerName" placeholder="Jane Doe" style="${FIELD_STYLE}">
      </div>
      <div>
        <label style="${FIELD_LABEL_STYLE}">Email address *</label>
        <input type="email" id="registerEmail" placeholder="you@company.com" style="${FIELD_STYLE}" ${configured ? 'readonly' : ''}>
      </div>
    </div>
    <div style="margin-bottom:10px;">
      <div id="registerEmailSignIn" style="${configured ? '' : 'display:none;'}"></div>
      <div id="registerEmailStatus" style="display:none;padding:8px 10px;border-radius:8px;font-size:12.5px;font-weight:600;"></div>
      ${configured ? '' : '<p style="margin:0;font-size:12px;color:#8a94a6;">Google Sign-In isn’t configured yet (see GOOGLE_CLIENT_ID in app.js) — the typed email won’t be verified.</p>'}
    </div>
    <div class="popup-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div>
        <label style="${FIELD_LABEL_STYLE}">Joining date *</label>
        <input type="date" id="registerJoiningDate" value="${today}" style="${FIELD_STYLE}">
      </div>
      <div>
        <label style="${FIELD_LABEL_STYLE}">End date (optional)</label>
        <input type="date" id="registerEndDate" style="${FIELD_STYLE}">
      </div>
    </div>
  `, { confirmLabel: 'Register' });

  popup.querySelector('#registerName').focus();

  const emailInput = popup.querySelector('#registerEmail');
  const signInWrap = popup.querySelector('#registerEmailSignIn');
  const statusEl = popup.querySelector('#registerEmailStatus');
  let verifiedEmail = null;

  function showStatus(text, tone) {
    statusEl.style.display = 'block';
    statusEl.textContent = text;
    statusEl.style.background = tone === 'ok' ? 'rgba(30,158,107,0.14)' : 'rgba(230,138,0,0.14)';
    statusEl.style.color = tone === 'ok' ? '#146B48' : '#E68A00';
  }

  if (configured) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response) => {
        signInWrap.style.display = 'none';
        showStatus('Verifying with Google…', 'pending');
        const email = await verifyGoogleIdToken(response.credential);
        if (!email) {
          signInWrap.style.display = '';
          showStatus('Could not verify that Google sign-in. Please try again.', 'warn');
          return;
        }
        if (isEmailRegistered(email)) {
          signInWrap.style.display = '';
          showStatus(`${email} is already registered.`, 'warn');
          return;
        }
        verifiedEmail = email;
        emailInput.value = email;
        showStatus(`Verified ${email} ✓`, 'ok');
      },
    });
    google.accounts.id.renderButton(signInWrap, { theme: 'outline', size: 'medium', width: 240 });
  }

  confirmBtn.addEventListener('click', () => {
    const name = popup.querySelector('#registerName').value.trim();
    const joiningDate = popup.querySelector('#registerJoiningDate').value;
    const endDate = popup.querySelector('#registerEndDate').value;
    if (!name) { alert("Please enter the employee's name."); return; }
    if (configured && !verifiedEmail) { alert('Please verify the email address with Google before registering.'); return; }
    const email = (verifiedEmail || emailInput.value.trim().toLowerCase());
    if (!EMAIL_RE.test(email)) { alert('Please enter a valid email address.'); return; }
    if (!joiningDate) { alert('Please select a joining date.'); return; }
    if (isEmailRegistered(email)) { alert('This email is already registered.'); return; }

    state.employees = state.employees || [];
    state.employees.push({ name, email, joiningDate, endDate: endDate || '', registeredAt: Date.now() });

    const hasList = state.lists.some((l) => !l.archived && sameEmployee(l.name, name));
    if (!hasList) {
      addList(name, email);
    } else {
      const existing = state.lists.find((l) => !l.archived && sameEmployee(l.name, name));
      if (existing && !existing.ownerEmail) existing.ownerEmail = email;
    }

    overlay.remove();
    logActivity('register', email, '', navigator.userAgent, name);
    showToast(`Registered ${name}`);
  });
}

function getTodayActivity(email, type) {
  const key = dateKey(new Date());
  return (state.activity || []).find((a) => a.email === email && a.type === type && dateKey(new Date(a.timestamp)) === key);
}

// Unlike getTodayActivity's .find() (first match, fine when there's only
// ever one entry like a single daily check-in), this is for types that can
// legitimately happen more than once today (copying the update again after
// re-editing tasks) -- the most recent one is what actually matters for
// "have they copied for the current window."
function getLatestTodayActivity(email, type) {
  const key = dateKey(new Date());
  const matches = (state.activity || []).filter((a) => a.email === email && a.type === type && dateKey(new Date(a.timestamp)) === key);
  if (!matches.length) return null;
  return matches.reduce((latest, a) => (a.timestamp > latest.timestamp ? a : latest), matches[0]);
}

// Unlike getLatestTodayActivity, not scoped to today -- for the access lock
// (getAccessLockInfo), which needs to know whether the LAST thing that
// happened was a checkin or a checkout regardless of which calendar day it
// landed on. Scoping to "today" broke this at every midnight: someone still
// on an overnight-open shift (checked in yesterday, never checked out) would
// suddenly read as "not checked in" the moment the date rolled over, since
// yesterday's checkin no longer counted as "today's" -- locking them out
// mid-shift for no real reason. Whoever/whatever happened most recently,
// on any day, is what the lock should reflect.
function getLatestActivity(email, type) {
  const matches = (state.activity || []).filter((a) => a.email === email && a.type === type);
  if (!matches.length) return null;
  return matches.reduce((latest, a) => (a.timestamp > latest.timestamp ? a : latest), matches[0]);
}

// How many times this type has happened today for this person -- used to
// label a repeat check-in/check-out ("2nd time today") since re-checking
// in after a checkout is allowed (see openAttendancePopup).
function getTodayActivityCount(email, type) {
  const key = dateKey(new Date());
  return (state.activity || []).filter((a) => a.email === email && a.type === type && dateKey(new Date(a.timestamp)) === key).length;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function fmtTimeOnly(ts) {
  const d = new Date(ts);
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${mins}`;
}

function openAttendancePopup(focusEmployeeName) {
  document.querySelectorAll('.regular-popup-overlay').forEach((m) => m.remove());
  const employees = getRegisteredEmployees();
  if (!employees.length) { alert('No registered employees yet. Please register first.'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'regular-popup-overlay';

  const popup = document.createElement('div');

  const heading = document.createElement('h2');
  heading.style.cssText = 'margin:0 0 4px 0;font-size:17px;font-weight:600;';
  heading.textContent = 'Attendance';
  popup.appendChild(heading);

  const configured = isGoogleSignInConfigured();
  let verifiedEmail = null;

  const subtext = document.createElement('p');
  subtext.style.cssText = 'margin:0 0 12px 0;font-size:12px;color:#8a94a6;';
  subtext.textContent = configured
    ? `Sign in with the Google account matching ${focusEmployeeName ? `${focusEmployeeName}’s` : 'your'} registered email to check in or out.`
    : 'Google Sign-In isn’t configured yet (see GOOGLE_CLIENT_ID in app.js) — anyone can check in for now.';
  popup.appendChild(subtext);

  const signInWrap = document.createElement('div');
  signInWrap.style.cssText = 'margin-bottom:12px;';
  popup.appendChild(signInWrap);

  const verifiedBanner = document.createElement('div');
  verifiedBanner.style.cssText = 'display:none;margin-bottom:12px;padding:8px 10px;border-radius:8px;background:rgba(31,70,144,0.12);color:#1F4690;font-size:12.5px;font-weight:600;';
  popup.appendChild(verifiedBanner);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  popup.appendChild(list);

  function renderRows() {
    list.innerHTML = '';
    employees.forEach((emp) => {
      const isSelf = verifiedEmail && emp.email === verifiedEmail;
      const isFocused = focusEmployeeName && !verifiedEmail && sameEmployee(emp.name, focusEmployeeName);
      const row = document.createElement('div');
      row.className = 'attendance-popup-row';
      row.dataset.email = emp.email;
      row.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid ${isSelf || isFocused ? '#1F4690' : '#eee'};border-radius:8px;${isSelf || isFocused ? '' : 'opacity:0.6;'}`;

      const nameEl = document.createElement('span');
      nameEl.style.cssText = 'font-weight:600;font-size:13px;';
      nameEl.textContent = emp.name || emp.email;
      row.appendChild(nameEl);

      const actionsWrap = document.createElement('div');
      actionsWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';

      // "Currently checked in" is whichever of checkin/checkout happened
      // most recently today, not just whether a checkin exists at all --
      // re-checking in after a checkout is allowed (unlimited sessions per
      // day), so someone can have checkin/checkout/checkin/... pairs.
      const checkin = getLatestTodayActivity(emp.email, 'checkin');
      const checkout = getLatestTodayActivity(emp.email, 'checkout');
      const isCheckedIn = Boolean(checkin) && (!checkout || checkin.timestamp > checkout.timestamp);
      const canAct = !configured || isSelf;

      if (!isCheckedIn) {
        if (checkout) {
          const outTime = document.createElement('span');
          outTime.style.cssText = 'font-size:11.5px;color:#1F4690;font-weight:600;';
          outTime.textContent = `Out ${fmtTimeOnly(checkout.timestamp)}`;
          actionsWrap.appendChild(outTime);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = checkout ? 'Check In Again' : 'Check In';
        btn.disabled = !canAct;
        btn.title = canAct ? '' : 'Sign in with this person’s Google account to check them in';
        btn.style.cssText = `padding:6px 12px;border:none;border-radius:999px;background:${canAct ? '#FFA500' : '#c7ccd6'};color:#fff;font-size:12px;font-weight:600;cursor:${canAct ? 'pointer' : 'not-allowed'};`;
        btn.addEventListener('click', () => {
          if (!canAct) return;
          // Ask WFH/WFO before actually logging the check-in, rather than
          // after -- so it's captured at the moment it's true, and there's
          // no separate edit step needed once it's on the activity entry.
          actionsWrap.innerHTML = '';
          const doCheckin = async (workMode) => {
            actionsWrap.innerHTML = '<span style="font-size:12px;color:#8a94a6;">…</span>';
            const ip = await fetchClientIp();
            logActivity('checkin', emp.email, ip, navigator.userAgent, emp.name, { workMode });
            renderRows();
          };
          const prompt = document.createElement('span');
          prompt.style.cssText = 'font-size:11.5px;color:#8a94a6;';
          prompt.textContent = 'Working from:';
          actionsWrap.appendChild(prompt);
          const wfhBtn = document.createElement('button');
          wfhBtn.type = 'button';
          wfhBtn.textContent = '🏠 WFH';
          wfhBtn.style.cssText = 'padding:6px 10px;border:none;border-radius:999px;background:#3A5BA0;color:#fff;font-size:12px;font-weight:600;cursor:pointer;';
          wfhBtn.addEventListener('click', () => doCheckin('WFH'));
          const wfoBtn = document.createElement('button');
          wfoBtn.type = 'button';
          wfoBtn.textContent = '🏢 WFO';
          wfoBtn.style.cssText = 'padding:6px 10px;border:none;border-radius:999px;background:#FFA500;color:#fff;font-size:12px;font-weight:600;cursor:pointer;';
          wfoBtn.addEventListener('click', () => doCheckin('WFO'));
          actionsWrap.appendChild(wfhBtn);
          actionsWrap.appendChild(wfoBtn);
        });
        actionsWrap.appendChild(btn);
      } else {
        const checkinCount = getTodayActivityCount(emp.email, 'checkin');
        const inTime = document.createElement('span');
        inTime.style.cssText = 'font-size:11.5px;color:#3A5BA0;font-weight:600;';
        inTime.textContent = `In ${fmtTimeOnly(checkin.timestamp)}${checkinCount > 1 ? ` (${ordinal(checkinCount)} time)` : ''}`;
        actionsWrap.appendChild(inTime);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Check Out';
        btn.disabled = !canAct;
        btn.title = canAct ? '' : 'Sign in with this person’s Google account to check them out';
        btn.style.cssText = `padding:6px 12px;border:none;border-radius:999px;background:${canAct ? '#3A5BA0' : '#c7ccd6'};color:#fff;font-size:12px;font-weight:600;cursor:${canAct ? 'pointer' : 'not-allowed'};`;
        btn.addEventListener('click', async () => {
          if (!canAct) return;
          btn.disabled = true;
          btn.textContent = '…';
          const ip = await fetchClientIp();
          logActivity('checkout', emp.email, ip, navigator.userAgent, emp.name);
          renderRows();
        });
        actionsWrap.appendChild(btn);
      }

      row.appendChild(actionsWrap);
      list.appendChild(row);
    });
  }
  renderRows();

  if (focusEmployeeName) {
    const target = employees.find((e) => sameEmployee(e.name, focusEmployeeName));
    if (target) {
      const row = list.querySelector(`[data-email="${CSS.escape(target.email)}"]`);
      row?.scrollIntoView({ block: 'nearest' });
    }
  }

  if (configured) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response) => {
        signInWrap.innerHTML = '<span style="font-size:12.5px;color:#8a94a6;">Verifying with Google…</span>';
        const email = await verifyGoogleIdToken(response.credential);
        if (!email) {
          signInWrap.innerHTML = '';
          google.accounts.id.renderButton(signInWrap, { theme: 'outline', size: 'medium', width: 240 });
          verifiedBanner.style.display = 'block';
          verifiedBanner.style.background = 'rgba(230,138,0,0.14)';
          verifiedBanner.style.color = '#E68A00';
          verifiedBanner.textContent = 'Could not verify that Google sign-in. Please try again.';
          return;
        }
        const match = employees.find((e) => e.email === email);
        signInWrap.innerHTML = '';
        verifiedBanner.style.display = 'block';
        if (match) {
          verifiedEmail = email;
          // This is the moment identity is actually proven for this device
          // -- binds it to this employee so the checked-out access lock
          // (see getAccessLockInfo) knows whose status to check from now on.
          // The global render() (safe to call here -- this popup lives on
          // document.body, not inside the board it rebuilds) makes the lock
          // apply immediately if they're not currently checked in, rather
          // than waiting for some other click to trigger it.
          setSignedInEmail(email);
          render();
          verifiedBanner.style.background = 'rgba(31,70,144,0.12)';
          verifiedBanner.style.color = '#1F4690';
          verifiedBanner.textContent = `Signed in as ${match.name || email} — you can check yourself in/out below.`;
        } else {
          verifiedBanner.style.background = 'rgba(230,138,0,0.14)';
          verifiedBanner.style.color = '#E68A00';
          verifiedBanner.textContent = `${email} isn’t registered as an employee, so it can’t check in.`;
        }
        renderRows();
      },
    });
    google.accounts.id.renderButton(signInWrap, { theme: 'outline', size: 'medium', width: 240 });
  }

  const closeRow = document.createElement('div');
  closeRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:14px;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'padding:8px 20px;border:1px solid #ddd;border-radius:999px;background:white;cursor:pointer;font-size:13.5px;font-weight:500;';
  closeBtn.addEventListener('click', () => overlay.remove());
  closeRow.appendChild(closeBtn);
  popup.appendChild(closeRow);

  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function openLeaveApplicationPopup() {
  document.querySelectorAll('.regular-popup-overlay').forEach((m) => m.remove());
  const employees = getRegisteredEmployees();
  if (!employees.length) { alert('No registered employees yet. Please register first.'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'regular-popup-overlay';

  const popup = document.createElement('div');
  popup.style.maxWidth = '440px';

  const heading = document.createElement('h2');
  heading.style.cssText = 'margin:0 0 12px 0;font-size:17px;font-weight:600;';
  heading.textContent = 'Leave Application';
  popup.appendChild(heading);

  const empWrap = document.createElement('div');
  empWrap.style.cssText = 'margin-bottom:12px;';
  const empLabel = document.createElement('label');
  empLabel.style.cssText = FIELD_LABEL_STYLE;
  empLabel.textContent = 'Employee';
  empWrap.appendChild(empLabel);
  const empSelect = document.createElement('select');
  empSelect.style.cssText = FIELD_STYLE;
  empSelect.innerHTML = '<option value="">Select employee…</option>'
    + employees.map((e) => `<option value="${escapeHtml(e.email)}">${escapeHtml(e.name || e.email)}</option>`).join('');
  empWrap.appendChild(empSelect);
  popup.appendChild(empWrap);

  const calLabel = document.createElement('label');
  calLabel.style.cssText = FIELD_LABEL_STYLE;
  calLabel.textContent = 'Click the dates on leave';
  popup.appendChild(calLabel);

  const calWrap = document.createElement('div');
  calWrap.className = 'leave-calendar';
  calWrap.style.cssText = 'margin-bottom:12px;';
  popup.appendChild(calWrap);

  let leaveMonth = firstDayOfMonth(new Date());
  const selectedDates = new Map(); // dateKey -> reason

  function renderLeaveCalendar() {
    calWrap.innerHTML = '';
    calWrap.appendChild(renderCalendarToolbar(leaveMonth, (next) => {
      leaveMonth = next;
      renderLeaveCalendar();
    }));

    const grid = document.createElement('div');
    grid.className = 'calendar-grid';
    const weekdayRow = document.createElement('div');
    weekdayRow.className = 'calendar-weekdays';
    WEEKDAYS.forEach((w) => {
      const cell = document.createElement('div');
      cell.textContent = w;
      weekdayRow.appendChild(cell);
    });
    grid.appendChild(weekdayRow);

    const days = document.createElement('div');
    days.className = 'calendar-days';
    const startOfGrid = addDays(leaveMonth, -leaveMonth.getDay());
    const today = todayStr();
    for (let i = 0; i < 42; i++) {
      const date = addDays(startOfGrid, i);
      const key = dateKey(date);
      const inMonth = date.getMonth() === leaveMonth.getMonth();
      const cell = document.createElement('div');
      cell.className = `calendar-cell${inMonth ? '' : ' outside'}${key === today ? ' today' : ''}${selectedDates.has(key) ? ' selected' : ''}`;
      const dayNum = document.createElement('div');
      dayNum.className = 'calendar-day-num';
      dayNum.textContent = date.getDate();
      cell.appendChild(dayNum);
      cell.addEventListener('click', () => {
        if (selectedDates.has(key)) selectedDates.delete(key);
        else selectedDates.set(key, '');
        renderLeaveCalendar();
        renderReasonList();
      });
      days.appendChild(cell);
    }
    grid.appendChild(days);
    calWrap.appendChild(grid);
  }

  const reasonLabel = document.createElement('label');
  reasonLabel.style.cssText = FIELD_LABEL_STYLE;
  reasonLabel.textContent = 'Selected dates & reason';
  popup.appendChild(reasonLabel);

  const reasonList = document.createElement('div');
  reasonList.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:14px;max-height:160px;overflow-y:auto;';
  popup.appendChild(reasonList);

  function renderReasonList() {
    reasonList.innerHTML = '';
    if (!selectedDates.size) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:12.5px;color:#8a94a6;';
      empty.textContent = 'Click dates on the calendar above to add them.';
      reasonList.appendChild(empty);
      return;
    }
    [...selectedDates.keys()].sort().forEach((key) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;';

      const label = document.createElement('span');
      label.style.cssText = 'font-size:12.5px;font-weight:600;white-space:nowrap;color:#1F4690;min-width:66px;';
      label.textContent = formatDateStrForShare(key);
      row.appendChild(label);

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Reason (optional)';
      input.value = selectedDates.get(key) || '';
      input.style.cssText = 'flex:1;padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:12.5px;box-sizing:border-box;';
      input.addEventListener('input', () => selectedDates.set(key, input.value));
      row.appendChild(input);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = 'Remove this date';
      rm.style.cssText = 'border:none;background:transparent;color:#8a94a6;font-size:16px;line-height:1;cursor:pointer;padding:0 4px;';
      rm.addEventListener('click', () => {
        selectedDates.delete(key);
        renderLeaveCalendar();
        renderReasonList();
      });
      row.appendChild(rm);

      reasonList.appendChild(row);
    });
  }

  renderLeaveCalendar();
  renderReasonList();

  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 20px;border:1px solid #ddd;border-radius:999px;background:white;cursor:pointer;font-size:13.5px;font-weight:500;';
  cancelBtn.addEventListener('click', () => overlay.remove());
  actionsRow.appendChild(cancelBtn);

  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.textContent = 'Done';
  doneBtn.style.cssText = 'padding:8px 20px;border:none;border-radius:999px;background:#FFA500;color:white;cursor:pointer;font-size:13.5px;font-weight:600;';
  doneBtn.addEventListener('click', () => {
    const email = empSelect.value;
    if (!email) { alert('Please select an employee.'); return; }
    if (!selectedDates.size) { alert('Please select at least one date on the calendar.'); return; }
    const emp = employees.find((e) => e.email === email);
    const leaveDates = [...selectedDates.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, reason]) => ({ date, reason: reason.trim() }));
    logActivity('leave', email, '', navigator.userAgent, emp?.name || email, { leaveDates });
    overlay.remove();
    showToast('Leave application submitted');
  });
  actionsRow.appendChild(doneBtn);
  popup.appendChild(actionsRow);

  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function exitEmployee(email) {
  const empIndex = state.employees.findIndex((e) => e.email === email);
  if (empIndex === -1) return;
  const employee = state.employees[empIndex];

  // Prefer the robust email link so a renamed list (or a name that no
  // longer matches after edits) still gets correctly tied to this
  // employee; only fall back to name-matching for older lists created
  // before ownerEmail existed.
  const list = state.lists.find((l) => l.ownerEmail && l.ownerEmail === employee.email)
    || state.lists.find((l) => !l.ownerEmail && sameEmployee(l.name, employee.name));

  const projectMemberships = [];
  state.projects.forEach((project) => {
    if (project.owners && project.owners.some((o) => sameEmployee(o, employee.name))) {
      projectMemberships.push({ projectId: project.id, projectName: project.name });
      project.owners = project.owners.filter((o) => !sameEmployee(o, employee.name));
      if (sameEmployee(project.owner, employee.name)) {
        project.owner = project.owners[0] || 'Unassigned';
      }
      if (project.owners.length === 0) {
        project.deleted = true;
        project.deletedAt = Date.now();
      }
    }
  });

  const regularTasks = (state.regular.tasks || []).filter((t) => sameEmployee(t.owner, employee.name));
  state.regular.tasks = (state.regular.tasks || []).filter((t) => !sameEmployee(t.owner, employee.name));

  const activityEntries = (state.activity || []).filter((a) => a.email === employee.email);
  state.activity = (state.activity || []).filter((a) => a.email !== employee.email);

  // Logged AFTER the filter above (not via logActivity(), which would
  // both double up the persist()/render() this function already does at
  // the end, and -- more importantly -- get immediately swept into
  // activityEntries/removed from state.activity by the filter that just
  // ran, since it also matches this employee's email) so the notice
  // itself survives in the live feed instead of vanishing into the bin
  // along with the rest of their history.
  state.activity = state.activity || [];
  state.activity.push({ id: uid('act'), type: 'exit', name: employee.name, email: employee.email, timestamp: Date.now(), ip: '', device: '' });

  if (list) {
    state.lists = state.lists.filter((l) => l.id !== list.id);
  }

  state.employees.splice(empIndex, 1);

  state.bin = state.bin || [];
  state.bin.push({
    id: uid('bin'),
    exitedAt: Date.now(),
    employee,
    list: list || null,
    projectMemberships,
    regularTasks,
    activity: activityEntries,
  });

  persist();
  render();
}

function restoreEmployee(binId) {
  const idx = (state.bin || []).findIndex((b) => b.id === binId);
  if (idx === -1) return;
  const entry = state.bin[idx];

  if (!isEmailRegistered(entry.employee.email)) {
    state.employees.push(entry.employee);
  }

  if (entry.list && !state.lists.some((l) => l.id === entry.list.id)) {
    state.lists.push(entry.list);
  }

  if (entry.projectMemberships) {
    entry.projectMemberships.forEach((pm) => {
      const p = state.projects.find((pr) => pr.id === pm.projectId) || state.projects.find((pr) => pr.name === pm.projectName);
      if (p) {
        p.owners = p.owners || [];
        if (!p.owners.some((o) => sameEmployee(o, entry.employee.name))) {
          p.owners.push(entry.employee.name);
        }
        if (!p.owner || p.owner === 'Unassigned') {
          p.owner = entry.employee.name;
        }
        if (p.deleted && p.owners.length > 0) {
          p.deleted = false;
          delete p.deletedAt;
        }
      }
    });
  }

  state.regular.tasks = state.regular.tasks || [];
  entry.regularTasks.forEach((task) => {
    if (!state.regular.tasks.some((t) => t.id === task.id)) state.regular.tasks.push(task);
  });

  state.activity = state.activity || [];
  entry.activity.forEach((a) => {
    if (!state.activity.some((existing) => existing.id === a.id)) state.activity.push(a);
  });

  state.bin.splice(idx, 1);

  state.activity = state.activity || [];
  state.activity.push({ id: uid('act'), type: 'employee_restored', name: entry.employee.name, email: entry.employee.email, timestamp: Date.now(), ip: '', device: '' });

  persist();
  render();
}

// Unlike restoreEmployee, there's no undo path back from this -- the
// employee's kept data (list, project memberships, regular tasks,
// activity history) is gone for good, not just hidden.
function permanentlyDeleteExitedEmployee(binId) {
  const idx = (state.bin || []).findIndex((b) => b.id === binId);
  if (idx === -1) return;
  state.bin.splice(idx, 1);
  persist();
  render();
}

function openExitPopup() {
  document.querySelectorAll('.regular-popup-overlay').forEach((m) => m.remove());

  const overlay = document.createElement('div');
  overlay.className = 'regular-popup-overlay';

  const popup = document.createElement('div');
  popup.style.maxWidth = '440px';

  const heading = document.createElement('h2');
  heading.style.cssText = 'margin:0 0 4px 0;font-size:17px;font-weight:600;';
  heading.textContent = 'Employee Exit';
  popup.appendChild(heading);

  const subtext = document.createElement('p');
  subtext.style.cssText = 'margin:0 0 12px 0;font-size:12px;color:#8a94a6;';
  subtext.textContent = 'Removes the employee and their data from view. Everything is kept safely and can be restored below if they rejoin.';
  popup.appendChild(subtext);

  const employees = getRegisteredEmployees();

  const activeLabel = document.createElement('label');
  activeLabel.style.cssText = FIELD_LABEL_STYLE;
  activeLabel.textContent = 'Select employee to exit';
  popup.appendChild(activeLabel);

  const select = document.createElement('select');
  select.id = 'exitEmployeeSelect';
  select.style.cssText = FIELD_STYLE;
  if (!employees.length) {
    select.innerHTML = '<option value="">No registered employees</option>';
    select.disabled = true;
  } else {
    select.innerHTML = employees.map((e) => `<option value="${escapeHtml(e.email)}">${escapeHtml(e.name || e.email)}</option>`).join('');
  }
  popup.appendChild(select);

  const exitBtnRow = document.createElement('div');
  exitBtnRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:10px;margin-bottom:16px;';
  const exitConfirmBtn = document.createElement('button');
  exitConfirmBtn.type = 'button';
  exitConfirmBtn.textContent = 'Exit Employee';
  exitConfirmBtn.style.cssText = 'padding:8px 20px;border:none;border-radius:999px;background:#E04858;color:#fff;cursor:pointer;font-size:13.5px;font-weight:600;';
  exitConfirmBtn.disabled = !employees.length;
  exitConfirmBtn.addEventListener('click', () => {
    const email = select.value;
    const emp = employees.find((e) => e.email === email);
    if (!emp) return;
    if (!confirm(`Remove ${emp.name || emp.email} and all their data from the app? This can be undone from the "Exited employees" list.`)) return;
    exitEmployee(email);
    overlay.remove();
    showToast(`${emp.name || emp.email} has exited. Data kept in the bin.`);
  });
  exitBtnRow.appendChild(exitConfirmBtn);
  popup.appendChild(exitBtnRow);

  const bin = state.bin || [];
  if (bin.length) {
    const binToggle = document.createElement('button');
    binToggle.type = 'button';
    binToggle.style.cssText = 'width:100%;display:flex;align-items:center;justify-content:space-between;background:none;border:none;border-top:1px solid #eee;padding:12px 0 0;font-weight:600;font-size:13px;cursor:pointer;color:inherit;';
    binToggle.innerHTML = `<span>Exited employees (${bin.length})</span><span class="bin-toggle-arrow" style="transition:transform 150ms ease;">&#9662;</span>`;
    popup.appendChild(binToggle);

    const binList = document.createElement('div');
    binList.style.cssText = 'display:none;flex-direction:column;gap:8px;margin-top:8px;';
    let binExpanded = false;
    const arrowEl = binToggle.querySelector('.bin-toggle-arrow');
    binToggle.addEventListener('click', () => {
      binExpanded = !binExpanded;
      binList.style.display = binExpanded ? 'flex' : 'none';
      arrowEl.style.transform = binExpanded ? 'rotate(180deg)' : 'rotate(0deg)';
    });
    bin.slice().sort((a, b) => b.exitedAt - a.exitedAt).forEach((entry) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid #eee;border-radius:8px;';

      const info = document.createElement('div');
      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-weight:600;font-size:13px;';
      nameEl.textContent = entry.employee.name || entry.employee.email;
      const dateEl = document.createElement('div');
      dateEl.style.cssText = 'font-size:11px;color:#8a94a6;margin-top:2px;';
      dateEl.textContent = `Exited ${fmtShort(entry.exitedAt)}`;
      info.appendChild(nameEl);
      info.appendChild(dateEl);
      row.appendChild(info);

      const rowActions = document.createElement('div');
      rowActions.style.cssText = 'display:flex;align-items:center;gap:6px;';

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.textContent = 'Restore';
      restoreBtn.style.cssText = 'padding:6px 12px;border:none;border-radius:999px;background:#1F4690;color:#fff;font-size:12px;font-weight:600;cursor:pointer;';
      restoreBtn.addEventListener('click', () => {
        restoreEmployee(entry.id);
        overlay.remove();
        showToast(`${entry.employee.name || entry.employee.email} restored.`);
      });
      rowActions.appendChild(restoreBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.innerHTML = '&times;';
      deleteBtn.title = 'Permanently delete this employee\'s data';
      deleteBtn.style.cssText = 'width:26px;height:26px;border:1px solid #eee;border-radius:999px;background:#fff;color:#8a94a6;font-size:15px;line-height:1;cursor:pointer;';
      deleteBtn.addEventListener('click', () => {
        const name = entry.employee.name || entry.employee.email;
        if (!confirm(`Permanently delete ${name}? Unlike exiting, this can't be undone -- their list, tasks, and activity history are gone for good.`)) return;
        permanentlyDeleteExitedEmployee(entry.id);
        overlay.remove();
        showToast(`${name} permanently deleted.`);
      });
      rowActions.appendChild(deleteBtn);

      row.appendChild(rowActions);

      binList.appendChild(row);
    });
    popup.appendChild(binList);
  }

  const closeRow = document.createElement('div');
  closeRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:14px;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'padding:8px 20px;border:1px solid #ddd;border-radius:999px;background:white;cursor:pointer;font-size:13.5px;font-weight:500;';
  closeBtn.addEventListener('click', () => overlay.remove());
  closeRow.appendChild(closeBtn);
  popup.appendChild(closeRow);

  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// Mon-first weekday order for schedule dropdowns (WEEKDAYS itself is
// Sun-first to match Date#getDay(), which is what's actually stored).
const WEEKDAY_PICKER_ORDER = [1, 2, 3, 4, 5, 6, 0];
const ORDINAL_WORDS = ['1st', '2nd', '3rd', '4th', '5th'];
const ORDINAL_MAP = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5 };

function hourlyTimeOptions(selected = '09:00') {
  return Array.from({ length: 24 }, (_, h) => {
    const value = `${String(h).padStart(2, '0')}:00`;
    return `<option value="${value}"${value === selected ? ' selected' : ''}>${value}</option>`;
  }).join('');
}

function weekdaySelectOptions(selectedDay = 1) {
  return WEEKDAY_PICKER_ORDER
    .map((idx) => `<option value="${idx}"${idx === selectedDay ? ' selected' : ''}>${WEEKDAYS[idx]}</option>`)
    .join('');
}

function dayOfMonthOptions(selected = 1) {
  return Array.from({ length: 31 }, (_, i) => i + 1)
    .map((d) => `<option value="${d}"${d === selected ? ' selected' : ''}>Day ${d}</option>`)
    .join('');
}

function ordinalSelectOptions(selected = 1) {
  return ORDINAL_WORDS
    .map((word, i) => `<option value="${i + 1}"${i + 1 === selected ? ' selected' : ''}>${word}</option>`)
    .join('');
}

function monthSelectOptions(selected = 0) {
  return MONTHS
    .map((m, i) => `<option value="${i}"${i === selected ? ' selected' : ''}>${m}</option>`)
    .join('');
}

function openAddRegularRowPopup() {
  const employees = getAllEmployees();
  const employeeOptions = employees.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
  const cadenceOptions = CADENCE_OPTIONS.map((c) => `<option value="${c}">${cadenceLabel(c)}</option>`).join('');

  const { overlay, popup, confirmBtn } = openRegularPopup('Add Regular Task', `
    <div style="margin-bottom:10px;">
      <label style="${FIELD_LABEL_STYLE}">Task Title *</label>
      <input type="text" id="regRowTitle" placeholder="Enter task title" style="${FIELD_STYLE}">
    </div>
    <div class="popup-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div>
        <label style="${FIELD_LABEL_STYLE}">Employee</label>
        <select id="regRowOwner" style="${FIELD_STYLE}"><option value="Unassigned">Unassigned</option>${employeeOptions}</select>
      </div>
      <div>
        <label style="${FIELD_LABEL_STYLE}">Cadence</label>
        <select id="regRowCadence" style="${FIELD_STYLE}">${cadenceOptions}</select>
      </div>
    </div>
    <div class="popup-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div style="position:relative;">
        <label style="${FIELD_LABEL_STYLE}">Category — groups this task under the chosen cadence</label>
        <input type="text" id="regRowCategory" placeholder="e.g. Social Media" autocomplete="off" style="${FIELD_STYLE}">
      </div>
      <div>
        <label style="${FIELD_LABEL_STYLE}">Priority</label>
        <select id="regRowPriority" style="${FIELD_STYLE}">
          <option value="none">No priority</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
    </div>

    <div id="regScheduleDaily" class="reg-schedule-section">
      <label style="${FIELD_LABEL_STYLE}">Time</label>
      <select id="regRowTime" style="${FIELD_STYLE}">${hourlyTimeOptions()}</select>
    </div>

    <div id="regScheduleWeekly" class="reg-schedule-section" style="display:none;">
      <label style="${FIELD_LABEL_STYLE}">Day of week</label>
      <select id="regRowWeekday" style="${FIELD_STYLE}">${weekdaySelectOptions()}</select>
    </div>

    <div id="regScheduleMonthly" class="reg-schedule-section" style="display:none;">
      <label style="${FIELD_LABEL_STYLE}">Monthly pattern</label>
      <div style="display:flex;gap:16px;margin-bottom:8px;font-size:13px;">
        <label style="display:flex;align-items:center;gap:5px;font-weight:400;"><input type="radio" name="regMonthlyMode" value="date" checked> On a date</label>
        <label style="display:flex;align-items:center;gap:5px;font-weight:400;"><input type="radio" name="regMonthlyMode" value="weekday"> On a weekday pattern</label>
      </div>
      <div id="regMonthlyDateWrap">
        <select id="regRowDayOfMonth" style="${FIELD_STYLE}">${dayOfMonthOptions()}</select>
      </div>
      <div id="regMonthlyWeekdayWrap" style="display:none;grid-template-columns:1fr 1fr;gap:10px;">
        <select id="regRowOrdinal" style="${FIELD_STYLE}">${ordinalSelectOptions()}</select>
        <select id="regRowMonthlyWeekday" style="${FIELD_STYLE}">${weekdaySelectOptions()}</select>
      </div>
    </div>

    <div id="regScheduleAnnualLike" class="reg-schedule-section" style="display:none;">
      <label style="${FIELD_LABEL_STYLE}">Month</label>
      <select id="regRowMonth" style="${FIELD_STYLE}">${monthSelectOptions()}</select>
      <div style="display:flex;gap:16px;margin:10px 0 8px;font-size:13px;">
        <label style="display:flex;align-items:center;gap:5px;font-weight:400;"><input type="radio" name="regAnnualMode" value="date" checked> On a date</label>
        <label style="display:flex;align-items:center;gap:5px;font-weight:400;"><input type="radio" name="regAnnualMode" value="weekday"> On a weekday pattern</label>
      </div>
      <div id="regAnnualDateWrap">
        <select id="regRowAnnualDate" style="${FIELD_STYLE}">${dayOfMonthOptions()}</select>
      </div>
      <div id="regAnnualWeekdayWrap" style="display:none;grid-template-columns:1fr 1fr;gap:10px;">
        <select id="regRowAnnualOrdinal" style="${FIELD_STYLE}">${ordinalSelectOptions()}</select>
        <select id="regRowAnnualWeekday" style="${FIELD_STYLE}">${weekdaySelectOptions()}</select>
      </div>
    </div>
  `, { confirmLabel: 'Add' });

  if (activeRegularEmployee !== 'all') {
    const sel = popup.querySelector('#regRowOwner');
    if ([...sel.options].some((o) => o.value === activeRegularEmployee)) sel.value = activeRegularEmployee;
  }

  const cadenceSel = popup.querySelector('#regRowCadence');
  const scheduleSections = {
    daily: popup.querySelector('#regScheduleDaily'),
    weekly: popup.querySelector('#regScheduleWeekly'),
    monthly: popup.querySelector('#regScheduleMonthly'),
    quarterly: popup.querySelector('#regScheduleAnnualLike'),
    'half-yearly': popup.querySelector('#regScheduleAnnualLike'),
    yearly: popup.querySelector('#regScheduleAnnualLike'),
  };
  const updateScheduleSections = () => {
    Object.values(scheduleSections).forEach((el) => { if (el) el.style.display = 'none'; });
    const target = scheduleSections[cadenceSel.value];
    if (target) target.style.display = '';
  };
  cadenceSel.addEventListener('change', updateScheduleSections);
  updateScheduleSections();

  const monthlyDateWrap = popup.querySelector('#regMonthlyDateWrap');
  const monthlyWeekdayWrap = popup.querySelector('#regMonthlyWeekdayWrap');
  popup.querySelectorAll('input[name="regMonthlyMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const mode = popup.querySelector('input[name="regMonthlyMode"]:checked').value;
      monthlyDateWrap.style.display = mode === 'date' ? '' : 'none';
      monthlyWeekdayWrap.style.display = mode === 'weekday' ? 'grid' : 'none';
    });
  });

  const annualDateWrap = popup.querySelector('#regAnnualDateWrap');
  const annualWeekdayWrap = popup.querySelector('#regAnnualWeekdayWrap');
  popup.querySelectorAll('input[name="regAnnualMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const mode = popup.querySelector('input[name="regAnnualMode"]:checked').value;
      annualDateWrap.style.display = mode === 'date' ? '' : 'none';
      annualWeekdayWrap.style.display = mode === 'weekday' ? 'grid' : 'none';
    });
  });

  // Category combobox — same type-to-filter / type-to-create suggestion
  // list used by the main task popup's category field, instead of a plain
  // native <datalist> (which renders inconsistently and doesn't match the
  // app's look).
  const categoryInput = popup.querySelector('#regRowCategory');
  const categorySuggestions = document.createElement('div');
  categorySuggestions.className = 'combo-suggestions';
  categorySuggestions.style.cssText = 'position:fixed;max-height:140px;z-index:1100;display:none;';
  document.body.appendChild(categorySuggestions);

  function positionCategorySuggestions() {
    const rect = categoryInput.getBoundingClientRect();
    categorySuggestions.style.left = `${rect.left}px`;
    categorySuggestions.style.top = `${rect.bottom + 2}px`;
    categorySuggestions.style.width = `${rect.width}px`;
  }
  function showCategorySuggestions() {
    const q = categoryInput.value.trim().toLowerCase();
    const matches = (state.categories || []).filter((c) => !q || c.toLowerCase().includes(q));
    if (!matches.length) { categorySuggestions.style.display = 'none'; return; }
    categorySuggestions.innerHTML = matches.map((c) => `<div class="category-suggestion" data-value="${escapeHtml(c)}" style="padding:6px 10px;cursor:pointer;font-size:13px;">${escapeHtml(c)}</div>`).join('');
    categorySuggestions.scrollTop = 0;
    positionCategorySuggestions();
    categorySuggestions.style.display = 'block';
  }
  categoryInput.addEventListener('focus', showCategorySuggestions);
  categoryInput.addEventListener('input', showCategorySuggestions);
  categorySuggestions.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const target = e.target.closest('.category-suggestion');
    if (target) {
      categoryInput.value = target.dataset.value;
      categorySuggestions.style.display = 'none';
    }
  });
  categoryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); categorySuggestions.style.display = 'none'; }
  });
  const closeCategoryOnOutsideClick = (e) => {
    if (!categoryInput.parentElement.contains(e.target) && !categorySuggestions.contains(e.target)) categorySuggestions.style.display = 'none';
  };
  const hideCategoryOnScroll = (e) => {
    if (e.target === categorySuggestions) return;
    categorySuggestions.style.display = 'none';
  };
  document.addEventListener('mousedown', closeCategoryOnOutsideClick);
  window.addEventListener('scroll', hideCategoryOnScroll, true);
  function cleanupCategoryCombo() {
    document.removeEventListener('mousedown', closeCategoryOnOutsideClick);
    window.removeEventListener('scroll', hideCategoryOnScroll, true);
    categorySuggestions.remove();
  }
  popup.querySelector('#regPopupCancel').addEventListener('click', cleanupCategoryCombo);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanupCategoryCombo(); });

  confirmBtn.addEventListener('click', () => {
    const title = popup.querySelector('#regRowTitle').value.trim();
    if (!title) { alert('Please enter a task title'); return; }
    const owner = popup.querySelector('#regRowOwner').value;
    const cadence = cadenceSel.value;
    const category = categoryInput.value.trim();
    const priority = popup.querySelector('#regRowPriority').value;
    if (category && !state.categories.some((c) => c.toLowerCase() === category.toLowerCase())) {
      state.categories.push(category);
    }
    // The group is always just the cadence -- category is a separate field
    // that nests as a sub-section INSIDE that cadence's block, not a
    // parallel top-level section of its own.
    const group = cadenceLabel(cadence);

    const details = { cadence, owner, title, category, group, priority };
    if (cadence === 'daily') {
      details.time = popup.querySelector('#regRowTime').value;
    } else if (cadence === 'weekly') {
      details.weekday = Number(popup.querySelector('#regRowWeekday').value);
    } else if (cadence === 'monthly') {
      const mode = popup.querySelector('input[name="regMonthlyMode"]:checked').value;
      details.monthlyMode = mode;
      if (mode === 'weekday') {
        details.weekdayOrdinal = Number(popup.querySelector('#regRowOrdinal').value);
        details.weekday = Number(popup.querySelector('#regRowMonthlyWeekday').value);
      } else {
        details.dayOfMonth = Number(popup.querySelector('#regRowDayOfMonth').value);
      }
    } else {
      details.month = Number(popup.querySelector('#regRowMonth').value);
      const mode = popup.querySelector('input[name="regAnnualMode"]:checked').value;
      details.monthlyMode = mode;
      if (mode === 'weekday') {
        details.weekdayOrdinal = Number(popup.querySelector('#regRowAnnualOrdinal').value);
        details.weekday = Number(popup.querySelector('#regRowAnnualWeekday').value);
      } else {
        details.dayOfMonth = Number(popup.querySelector('#regRowAnnualDate').value);
      }
    }

    let insertAfterId = null;
    for (let i = state.regular.tasks.length - 1; i >= 0; i--) {
      const t = state.regular.tasks[i];
      if (t.cadence === cadence && (t.category || '') === category) { insertAfterId = t.id; break; }
    }
    if (insertAfterId === null) {
      for (let i = state.regular.tasks.length - 1; i >= 0; i--) {
        const t = state.regular.tasks[i];
        if (t.cadence === cadence) { insertAfterId = t.id; break; }
      }
    }
    details.insertAfterId = insertAfterId;
    addRegularTaskWith(details);
    cleanupCategoryCombo();
    overlay.remove();
  });
}

function openRemoveRegularRowPopup() {
  const visible = getRegularTasks();
  if (!visible.length) { alert('No regular tasks to remove.'); return; }
  const options = visible.map((t) => `<option value="${t.id}">${escapeHtml(t.owner)} — ${escapeHtml(t.title)} (${cadenceLabel(t.cadence)})</option>`).join('');

  const { overlay, popup, confirmBtn } = openRegularPopup('Remove Regular Task', `
    <div>
      <label style="${FIELD_LABEL_STYLE}">Which task?</label>
      <select id="regRemoveSelect" style="${FIELD_STYLE}">${options}</select>
    </div>
  `, { confirmLabel: 'Remove', danger: true });

  confirmBtn.addEventListener('click', () => {
    const id = popup.querySelector('#regRemoveSelect').value;
    deleteRegularTask(id);
    overlay.remove();
  });
}

function ensureRegularColumns() {
  if (!state.regular) state.regular = { columns: [] };
  if (!Array.isArray(state.regular.columns) || !state.regular.columns.length) {
    state.regular.columns = Array.from({ length: daysInMonth(regularStartDate) }, (_, index) => dateKey(addDays(regularStartDate, index)));
  }
}

function moveRegularColumn(fromIndex, toIndex) {
  ensureRegularColumns();
  const columns = [...state.regular.columns];
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= columns.length || toIndex >= columns.length) return;
  const [moved] = columns.splice(fromIndex, 1);
  columns.splice(toIndex, 0, moved);
  state.regular.columns = columns;
  persist();
  render();
}

function deleteRegularTask(taskId) {
  const idx = state.regular.tasks.findIndex((task) => task.id === taskId);
  if (idx === -1) return;
  state.regular.tasks.splice(idx, 1);
  refreshRegularEmployees();
  persist();
  render();
}

function moveRegularRow(fromId, toId) {
  const tasks = [...(state.regular.tasks || [])];
  const fromIdx = tasks.findIndex((task) => task.id === fromId);
  const toIdx = tasks.findIndex((task) => task.id === toId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
  const [moved] = tasks.splice(fromIdx, 1);
  tasks.splice(toIdx, 0, moved);
  state.regular.tasks = tasks;
  persist();
  render();
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

// Shared by monthly/quarterly/half-yearly/yearly tasks in "weekday pattern"
// mode (e.g. "2nd Monday", capped at the 5th occurrence -- a small handful
// of months have 5 of a given weekday, so this isn't purely academic).
function matchesWeekdayPattern(task, date) {
  if (date.getDay() !== task.weekday) return false;
  const ordinal = Math.ceil(date.getDate() / 7);
  return ordinal === Math.min(5, task.weekdayOrdinal || 1);
}

function matchesDateOrWeekdayPattern(task, date) {
  return task.monthlyMode === 'weekday' ? matchesWeekdayPattern(task, date) : date.getDate() === task.dayOfMonth;
}

function isRegularTaskExpected(task, date) {
  const refMonth = Number.isInteger(task.month) ? task.month : 0;
  const monthsSinceRef = ((date.getMonth() - refMonth) % 12 + 12) % 12;
  if (task.cadence === 'daily') return date.getDay() !== 0;
  if (task.cadence === 'weekly') return date.getDay() === task.weekday;
  if (task.cadence === 'monthly') return matchesDateOrWeekdayPattern(task, date);
  if (task.cadence === 'quarterly') return monthsSinceRef % 3 === 0 && matchesDateOrWeekdayPattern(task, date);
  if (task.cadence === 'half-yearly') return monthsSinceRef % 6 === 0 && matchesDateOrWeekdayPattern(task, date);
  if (task.cadence === 'yearly') return date.getMonth() === refMonth && matchesDateOrWeekdayPattern(task, date);
  return false;
}

function isPastDate(date) {
  return dateKey(date) < todayStr();
}

function completionKey(taskId, date) {
  return `${taskId}:${dateKey(date)}`;
}

function isRegularDone(task, date) {
  return Boolean(state.regular?.completions?.[completionKey(task.id, date)]);
}

function regularTaskProgress(task, dates = getRegularDates()) {
  const expected = dates.filter((date) => isRegularTaskExpected(task, date));
  if (!expected.length) return { done: 0, total: 0, pct: 0 };
  const done = expected.filter((date) => isRegularDone(task, date)).length;
  return { done, total: expected.length, pct: Math.round((done / expected.length) * 100) };
}

function regularOverallProgress() {
  const dates = getRegularDates();
  const tasks = state.regular?.tasks || [];
  const totals = tasks.reduce((acc, task) => {
    const progress = regularTaskProgress(task, dates);
    acc.done += progress.done;
    acc.total += progress.total;
    return acc;
  }, { done: 0, total: 0 });
  return totals.total ? Math.round((totals.done / totals.total) * 100) : 0;
}

function toggleRegularCompletion(task, date) {
  state.regular.completions = state.regular.completions || {};
  const key = completionKey(task.id, date);
  if (state.regular.completions[key]) {
    delete state.regular.completions[key];
  } else {
    state.regular.completions[key] = true;
    logBoardEvent('regular_completed', `Regular task completed: "${task.title}"`);
  }
  persist();
  render();
}

function refreshRegularEmployees() {
  state.regular.employees = [...new Set(state.regular.tasks.map((task) => task.owner))].sort();
  if (activeRegularEmployee !== 'all' && !state.regular.employees.some((e) => sameEmployee(e, activeRegularEmployee))) {
    activeRegularEmployee = 'all';
  }
}

function renameRegularEmployee(oldName, newName) {
  const clean = newName.trim();
  if (!clean || clean === oldName) return;
  state.regular.tasks.forEach((task) => {
    if (task.owner === oldName) task.owner = clean;
  });
  activeRegularEmployee = clean;
  refreshRegularEmployees();
  persist();
  render();
}

function updateRegularTask(task, field, value) {
  const clean = String(value).trim();
  if (field === 'cadence') {
    const normalized = clean.toLowerCase();
    if (normalized.startsWith('d')) task.cadence = 'daily';
    else if (normalized.startsWith('w')) task.cadence = 'weekly';
    else if (normalized.startsWith('m')) task.cadence = 'monthly';
    else return;
  } else if (field === 'group') {
    task[field] = clean;
  } else {
    if (!clean) return;
    task[field] = clean;
  }
  refreshRegularEmployees();
  persist();
  render();
}

function cycleRegularPriority(task) {
  const idx = PRIORITY_ORDER.indexOf(task.priority || 'none');
  task.priority = PRIORITY_ORDER[(idx + 1) % PRIORITY_ORDER.length];
  persist();
  render();
}

function renderRegularPriorityCell(task) {
  const td = document.createElement('td');
  const value = task.priority || 'none';
  const pill = document.createElement('span');
  pill.className = `task-priority regular-priority-pill ${value}`;
  pill.textContent = value === 'high' ? 'High' : value === 'medium' ? 'Medium' : value === 'low' ? 'Low' : '+ Priority';
  pill.title = 'Click to cycle priority';
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleRegularPriority(task);
  });
  td.appendChild(pill);
  return td;
}

// The Time/Schedule column doubles as the input for when a task recurs,
// read according to its cadence: a weekday name for weekly, a day-of-month
// number for monthly, and "day month" (e.g. "15 Jan") for cadences that
// also need a reference month (quarterly/half-yearly/yearly).
function updateRegularSchedule(task, value) {
  const clean = String(value).trim();
  if (task.cadence === 'daily') {
    task.time = clean;
  } else if (task.cadence === 'weekly') {
    const idx = WEEKDAYS.findIndex((day) => day.toLowerCase().startsWith(clean.slice(0, 3).toLowerCase()));
    if (idx >= 0) task.weekday = idx;
  } else if (task.cadence === 'monthly') {
    const patternMatch = clean.match(/^(1st|2nd|3rd|4th|5th)\s+([A-Za-z]{3,})/i);
    if (patternMatch) {
      const idx = WEEKDAYS.findIndex((day) => day.toLowerCase().startsWith(patternMatch[2].slice(0, 3).toLowerCase()));
      if (idx >= 0) {
        task.monthlyMode = 'weekday';
        task.weekdayOrdinal = ORDINAL_MAP[patternMatch[1].toLowerCase()];
        task.weekday = idx;
      }
    } else {
      const day = Number.parseInt(clean, 10);
      if (day) {
        task.monthlyMode = 'date';
        task.dayOfMonth = Math.max(1, Math.min(31, day));
      }
    }
  } else {
    // quarterly / half-yearly / yearly -- both a month and either a plain
    // date ("Oct 15") or a weekday pattern ("Mar 2nd Mon") need parsing.
    const patternMatch = clean.match(/(1st|2nd|3rd|4th|5th)\s+([A-Za-z]{3,})/i);
    if (patternMatch) {
      const idx = WEEKDAYS.findIndex((day) => day.toLowerCase().startsWith(patternMatch[2].slice(0, 3).toLowerCase()));
      if (idx >= 0) {
        task.monthlyMode = 'weekday';
        task.weekdayOrdinal = ORDINAL_MAP[patternMatch[1].toLowerCase()];
        task.weekday = idx;
      }
      const monthMatch = clean.slice(0, patternMatch.index).match(/[A-Za-z]{3,}/);
      if (monthMatch) {
        const mIdx = MONTHS.findIndex((m) => m.toLowerCase() === monthMatch[0].slice(0, 3).toLowerCase());
        if (mIdx >= 0) task.month = mIdx;
      }
    } else {
      task.monthlyMode = 'date';
      const dayMatch = clean.match(/\d{1,2}/);
      if (dayMatch) task.dayOfMonth = Math.max(1, Math.min(31, Number.parseInt(dayMatch[0], 10)));
      const monthMatch = clean.match(/[A-Za-z]{3,}/);
      if (monthMatch) {
        const idx = MONTHS.findIndex((m) => m.toLowerCase() === monthMatch[0].slice(0, 3).toLowerCase());
        if (idx >= 0) task.month = idx;
      } else {
        const parts = clean.split(/[\/\-\s]+/).filter(Boolean);
        if (parts.length >= 2) {
          const m = Number.parseInt(parts[1], 10);
          if (m >= 1 && m <= 12) task.month = m - 1;
        }
      }
    }
  }
  persist();
  render();
}

function regularScheduleValue(task) {
  return task.cadence === 'daily' ? (task.time || '') : regularScheduleLabel(task);
}

function regularSchedulePlaceholder(cadence) {
  if (cadence === 'weekly') return 'e.g. Monday';
  if (cadence === 'monthly') return 'e.g. 15 or "2nd Mon"';
  if (cadence === 'quarterly' || cadence === 'half-yearly' || cadence === 'yearly') return 'e.g. 15 Jan';
  return 'Enter time';
}

function editableText(value, onCommit, className = 'editable-cell', placeholder = '') {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = value;
  if (!value && placeholder) span.dataset.placeholder = placeholder;
  span.contentEditable = true;
  span.spellcheck = false;
  span.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); span.textContent = value; span.blur(); }
  });
  span.addEventListener('blur', () => onCommit(span.textContent));
  return span;
}

// Click-to-edit category chip, same interaction as the due-date/status
// controls right next to it. Typing a brand-new category registers it in
// state.categories too, same as every other category entry point.
function renderCategoryChip(record, onCommit) {
  const chip = editableText(record.category || '', (value) => {
    const clean = value.trim();
    if (clean === (record.category || '')) return;
    if (clean && !state.categories.some((c) => c.toLowerCase() === clean.toLowerCase())) {
      state.categories.push(clean);
    }
    onCommit(clean);
  }, 'project-chip category-chip editable-chip', '+ category');
  chip.title = 'Click to change category';
  chip.addEventListener('click', (e) => e.stopPropagation());
  return chip;
}

// ---------- rendering ----------

const SCROLL_PANEL_SELECTOR = '.regular-grid-panel, .table-panel, .stack-panel';
let lastRenderKey = null;

// "Archived / + Add" only makes sense for the main task board -- Tabs
// gets its own single "+ Add Website" action instead, Productivity
// gets its "Download PDF" button, and Analytics gets none. Only one of
// the viewbar-actions containers is ever shown at a time.
function setViewbarActions(mode) {
  mainViewActionsEl.classList.toggle('hidden', mode !== 'main');
  kraViewActionsEl.classList.toggle('hidden', mode !== 'kra');
  productivityViewActionsEl.classList.toggle('hidden', mode !== 'productivity');
  if (mode !== 'kra') kraViewActionsEl.innerHTML = '';
  if (mode !== 'productivity') productivityViewActionsEl.innerHTML = '';
}

// Only these accounts are always exempt from the lock -- NOT "anything
// that isn't a registered employee". That was the bug: any random Google
// account verified through "Switch account" isn't a registered employee
// either, so it was falling through the same "not an employee = exempt"
// path meant for the admin and getting full access with zero real check.
const ADMIN_EMAILS = ['tikonacapital@gmail.com'];

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || '').toLowerCase());
}

// Locked whenever this device is bound (see SIGNED_IN_EMAIL_KEY) to either:
// - a registered employee who isn't currently checked in (covers both
//   "never checked in today" and "checked out"), or
// - a verified email that's neither an admin nor a registered employee at
//   all (denied outright -- there's nothing for them to check into).
// A device that's never identified itself here at all (nobody's verified
// via the Attendance popup or Switch account yet) is never locked, same as
// the rest of this app's no-login-wall design -- only ADMIN_EMAILS is ever
// treated as exempt once an identity IS attached to the device.
function getAccessLockInfo() {
  const email = getSignedInEmail();
  if (!email) return null;
  if (isAdminEmail(email)) return null;
  const emp = getRegisteredEmployees().find((e) => e.email === email);
  if (!emp) return { emp: null, email, unrecognized: true };
  const checkin = getLatestActivity(email, 'checkin');
  const checkout = getLatestActivity(email, 'checkout');
  const isCheckedIn = Boolean(checkin) && (!checkout || checkin.timestamp > checkout.timestamp);
  if (isCheckedIn) return null;
  return { emp, checkout };
}

function renderAccessLock(lockInfo) {
  const overlay = document.getElementById('accessLockOverlay');
  if (!overlay) return;
  if (!lockInfo) {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
    return;
  }

  overlay.classList.remove('hidden');

  if (lockInfo.unrecognized) {
    overlay.innerHTML = `
      <div class="access-lock-card">
        <div class="access-lock-icon">⛔</div>
        <h2>Access denied</h2>
        <p>${escapeHtml(lockInfo.email)} isn’t a registered employee, so there's nothing to check in to.</p>
        <button type="button" id="accessLockSwitch" class="access-lock-switch">Try a different account</button>
      </div>
    `;
    overlay.querySelector('#accessLockSwitch').addEventListener('click', () => {
      pendingAccountSwitch = true;
      render();
    });
    return;
  }

  const { emp, checkout } = lockInfo;
  overlay.innerHTML = `
    <div class="access-lock-card">
      <div class="access-lock-icon">🔒</div>
      <h2>You're checked out</h2>
      <p>Hi ${escapeHtml(emp.name || emp.email)} — Orbit is locked until you check back in.</p>
      ${checkout ? `<p class="access-lock-sub">Last checked out at ${fmtTimeOnly(checkout.timestamp)}</p>` : ''}
      <div id="accessLockActions" class="access-lock-actions"></div>
      <button type="button" id="accessLockSwitch" class="access-lock-switch">Not ${escapeHtml(emp.name || 'you')}? Switch account</button>
    </div>
  `;

  const actions = overlay.querySelector('#accessLockActions');
  const doCheckin = async (workMode) => {
    actions.innerHTML = '<span class="access-lock-loading">Checking in…</span>';
    const ip = await fetchClientIp();
    // logActivity() itself calls persist() + render() -- the re-render
    // re-evaluates getAccessLockInfo() and finds them checked in, so the
    // overlay lifts on its own with no extra call needed here.
    logActivity('checkin', emp.email, ip, navigator.userAgent, emp.name, { workMode });
  };
  const wfhBtn = document.createElement('button');
  wfhBtn.type = 'button';
  wfhBtn.className = 'access-lock-btn wfh';
  wfhBtn.textContent = '🏠 Check In — WFH';
  wfhBtn.addEventListener('click', () => doCheckin('WFH'));
  const wfoBtn = document.createElement('button');
  wfoBtn.type = 'button';
  wfoBtn.className = 'access-lock-btn wfo';
  wfoBtn.textContent = '🏢 Check In — WFO';
  wfoBtn.addEventListener('click', () => doCheckin('WFO'));
  actions.appendChild(wfhBtn);
  actions.appendChild(wfoBtn);

  overlay.querySelector('#accessLockSwitch').addEventListener('click', () => {
    pendingAccountSwitch = true;
    render();
  });
}

// Shown instead of the lock while switching accounts (see accessLockSwitch
// above). Deliberately does NOT clear the stored binding until a NEW
// identity is actually verified with Google -- clearing it up front and
// falling back to render()'s normal "no stored email = open access" path
// was the bug: anyone locked out could tap "Switch account" and get full
// access with no verification at all. Cancelling here leaves the original
// binding untouched, so the original lock (if any) is exactly where it was.
let pendingAccountSwitch = false;

function renderAccountSwitchPrompt() {
  const overlay = document.getElementById('accessLockOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="access-lock-card">
      <div class="access-lock-icon">🔑</div>
      <h2>Sign in to continue</h2>
      <p>Verify with Google to switch which account this device belongs to.</p>
      <div id="accessSwitchSignIn" class="access-switch-signin"></div>
      <button type="button" id="accessSwitchCancel" class="access-lock-switch">Cancel</button>
    </div>
  `;

  const signInWrap = overlay.querySelector('#accessSwitchSignIn');
  if (isGoogleSignInConfigured()) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response) => {
        signInWrap.innerHTML = '<span class="access-lock-loading">Verifying…</span>';
        const email = await verifyGoogleIdToken(response.credential);
        if (!email) {
          pendingAccountSwitch = false;
          render();
          return;
        }
        // Always bind whatever verified, even if it's neither an admin nor
        // a registered employee -- getAccessLockInfo() classifies it fresh
        // every render anyway, and NOT storing it would let a reload fall
        // back to the "never identified = open" default, silently undoing
        // the "access denied" this same email should get.
        setSignedInEmail(email);
        pendingAccountSwitch = false;
        render();
      },
    });
    google.accounts.id.renderButton(signInWrap, { theme: 'outline', size: 'medium', width: 220 });
  } else {
    signInWrap.innerHTML = '<p class="access-lock-sub">Google Sign-In isn’t configured — can’t verify an account switch.</p>';
  }

  overlay.querySelector('#accessSwitchCancel').addEventListener('click', () => {
    pendingAccountSwitch = false;
    render();
  });
}

function render() {
  if (pendingAccountSwitch) {
    renderAccountSwitchPrompt();
    return;
  }
  const lockInfo = getAccessLockInfo();
  renderAccessLock(lockInfo);
  if (lockInfo) return;

  const renderKey = `${activeWorkspace}:${viewMode}:${activeListId}:${activeRegularEmployee}:${activeProjectEmployee}:${activeQuickPriority}:${activeQuickStatus}:${searchQuery}`;
  const preserveScroll = renderKey === lastRenderKey;
  const scrollTarget = preserveScroll ? boardEl.querySelector(SCROLL_PANEL_SELECTOR) : null;
  const savedScroll = scrollTarget ? { top: scrollTarget.scrollTop, left: scrollTarget.scrollLeft } : null;

  // Every render() fully rebuilds the board, which would otherwise snap
  // every per-card task list back to scrollTop 0 on every single click
  // anywhere in the app — that constant jump is what reads as "flicker".
  // Save/restore scroll position for each of those by a stable key instead.
  const savedCardScrolls = new Map();
  if (preserveScroll) {
    boardEl.querySelectorAll('[data-scroll-key]').forEach((el) => {
      if (el.scrollTop > 0) savedCardScrolls.set(el.dataset.scrollKey, el.scrollTop);
    });
  }

  try {
    // Build all new content off-screen first. Only swap it into the live
    // board once everything below has succeeded, so a mid-render error can
    // never leave the board wiped and blank (previously boardEl was cleared
    // up front, and since render() is called from many click handlers with
    // no surrounding try/catch, any thrown error left the page stuck blank
    // until a manual refresh).
    renderSidebar();
    renderViewTabs();
    renderPinnedState();

    if (activeWorkspace === 'charts') {
      setViewbarActions('none');
      renderChartsDashboardHeader();
      const chartsBoard = renderChartsWorkspace();
      boardEl.innerHTML = '';
      boardEl.className = 'board charts-board';
      boardEl.appendChild(chartsBoard);
      lastRenderKey = renderKey;
      return;
    }

    if (activeWorkspace === 'productivity') {
      setViewbarActions('productivity');
      dashboardTitleEl.textContent = 'Reports';
      statsEl.innerHTML = '';
      boardEl.innerHTML = '';
      boardEl.className = 'board';
      boardEl.appendChild(renderProductivityWorkspace());
      lastRenderKey = renderKey;
      return;
    }

    if (activeWorkspace === 'kra') {
      setViewbarActions('kra');
      dashboardTitleEl.textContent = 'Tabs';
      statsEl.innerHTML = '';
      boardEl.innerHTML = '';
      boardEl.className = 'board';
      boardEl.appendChild(renderKraWorkspace());
      lastRenderKey = renderKey;
      return;
    }

    setViewbarActions('main');
    renderDashboardHeader();

    const boardTop = document.createElement('div');
    boardTop.className = 'board-top';

    const effectiveViewMode = isMobileViewport() ? 'board' : viewMode;
    if (effectiveViewMode === 'table') {
      boardTop.appendChild(renderTableView());
    } else if (effectiveViewMode === 'stack') {
      boardTop.appendChild(renderStackView());
    } else if (effectiveViewMode === 'calendar') {
      boardTop.appendChild(renderCalendarView());
    } else {
      getVisibleLists().forEach((list) => boardTop.appendChild(renderList(list)));
      // A single employee is selected (not "All tasks") — show their due
      // dates as a mini calendar beside their task card, same idea as the
      // full Calendar view but scoped to just this person.
      if (activeListId !== 'all') {
        const selectedList = findList(activeListId);
        if (selectedList) boardTop.appendChild(renderEmployeeMiniCalendar(selectedList));
      }
    }

    const projectSection = renderProjectSection();
    const regularSection = renderRegularSection();
    const attendanceSection = renderAttendanceSection();
    const activitySection = renderActivitySection();

    boardEl.innerHTML = '';
    boardEl.className = `board view-${viewMode}`;
    boardEl.appendChild(boardTop);
    boardEl.appendChild(projectSection);
    boardEl.appendChild(regularSection);
    boardEl.appendChild(attendanceSection);
    boardEl.appendChild(activitySection);

    lastRenderKey = renderKey;
    if (savedScroll) {
      const next = boardEl.querySelector(SCROLL_PANEL_SELECTOR);
      if (next) {
        next.scrollTop = savedScroll.top;
        next.scrollLeft = savedScroll.left;
      }
    }
    if (savedCardScrolls.size) {
      boardEl.querySelectorAll('[data-scroll-key]').forEach((el) => {
        const top = savedCardScrolls.get(el.dataset.scrollKey);
        if (top) el.scrollTop = top;
      });
    }
  } catch (err) {
    console.error('Tikona Tasklist render failed, keeping previous view visible', err);
    showFatal('Something went wrong updating the view. Your data was not lost — try again or refresh.', err);
  }
}

// A small chevron toggle used next to any collapsible sidebar group header
// (All tasks' employee list, Tabs' tab list). Rotates via the .expanded
// class instead of swapping icons.
function renderSidebarArrow(expanded, onToggle) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `sidebar-group-arrow${expanded ? ' expanded' : ''}`;
  btn.title = expanded ? 'Collapse' : 'Expand';
  btn.innerHTML = '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle();
  });
  return btn;
}

function renderSidebar() {
  const top = document.getElementById('sidebarTop');
  const bottom = document.getElementById('sidebarBottom');
  top.innerHTML = '';
  bottom.innerHTML = '';

  const createSectionHeader = (title) => {
    const header = document.createElement('div');
    header.className = 'sidebar-section-header';
    header.textContent = title;
    return header;
  };

  top.appendChild(createSectionHeader('Workspace'));

  // ---- All tasks group: "All tasks" always visible, the per-employee
  // list beneath it collapses behind its own arrow. ----
  const activeLists = getActiveLists();
  const totals = activeLists.reduce((acc, list) => {
    const stats = listTaskStats(list);
    acc.open += stats.open;
    acc.done += stats.done;
    acc.total += stats.total;
    return acc;
  }, { open: 0, done: 0, total: 0 });

  const tasksGroup = document.createElement('div');
  tasksGroup.className = 'sidebar-group';

  const tasksHeaderRow = document.createElement('div');
  tasksHeaderRow.className = 'sidebar-group-header-row';
  tasksHeaderRow.appendChild(renderNavItem({
    id: 'all',
    name: 'All tasks',
    count: totals.open,
    active: activeWorkspace === 'tasks' && activeListId === 'all',
    progress: totals.total ? Math.round((totals.done / totals.total) * 100) : 0,
    color: 'var(--accent)',
  }));
  tasksHeaderRow.appendChild(renderSidebarArrow(sidebarTasksExpanded, () => {
    sidebarTasksExpanded = !sidebarTasksExpanded;
    render();
  }));
  tasksGroup.appendChild(tasksHeaderRow);

  const tasksSubnav = document.createElement('div');
  tasksSubnav.className = `sidebar-subnav${sidebarTasksExpanded ? '' : ' hidden'}`;
  activeLists.forEach((list) => {
    const stats = listTaskStats(list);
    tasksSubnav.appendChild(renderNavItem({
      id: list.id,
      name: list.name,
      count: stats.open,
      active: activeWorkspace === 'tasks' && activeListId === list.id,
      overdue: stats.overdue,
      progress: stats.total ? Math.round((stats.done / stats.total) * 100) : 0,
      color: listAccentColor(list.id),
    }));
  });
  tasksGroup.appendChild(tasksSubnav);
  top.appendChild(tasksGroup);

  top.appendChild(createSectionHeader('Lists'));

  // ---- Tabs group: same collapse pattern, sub-list is the actual Tabs
  // workspace's tabs (state.kraTabs) so you can jump straight to one. ----
  const tabsGroup = document.createElement('div');
  tabsGroup.className = 'sidebar-group';

  const tabsHeaderRow = document.createElement('div');
  tabsHeaderRow.className = 'sidebar-group-header-row';
  const tabsBtn = document.createElement('button');
  tabsBtn.type = 'button';
  tabsBtn.id = 'kraBtn';
  tabsBtn.className = `sidebar-item${activeWorkspace === 'kra' ? ' active' : ''}`;
  tabsBtn.title = 'Tabs';
  tabsBtn.innerHTML = '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="4"/><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/></svg><span class="nav-label">Tabs</span>';
  tabsBtn.addEventListener('click', () => {
    activeWorkspace = 'kra';
    render();
  });
  tabsHeaderRow.appendChild(tabsBtn);
  tabsHeaderRow.appendChild(renderSidebarArrow(sidebarTabsExpanded, () => {
    sidebarTabsExpanded = !sidebarTabsExpanded;
    render();
  }));
  tabsGroup.appendChild(tabsHeaderRow);

  const tabsSubnav = document.createElement('div');
  tabsSubnav.className = `sidebar-subnav${sidebarTabsExpanded ? '' : ' hidden'}`;
  const kraTabs = state.kraTabs || [];
  kraTabs.forEach((tab) => {
    const row = document.createElement('div');
    row.className = 'sidebar-subitem-row';

    const item = document.createElement('button');
    item.type = 'button';
    item.className = `sidebar-subitem${activeWorkspace === 'kra' && state.activeKraTabId === tab.id ? ' active' : ''}`;
    item.textContent = tab.name;
    item.title = 'Open this tab — double-click to rename';
    item.addEventListener('click', () => {
      activeWorkspace = 'kra';
      state.activeKraTabId = tab.id;
      persist();
      render();
    });
    item.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameKraTab(tab);
    });
    row.appendChild(item);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'sidebar-subitem-remove';
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Remove tab';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeKraTab(tab);
    });
    row.appendChild(removeBtn);

    tabsSubnav.appendChild(row);
  });

  const addTabBtn = document.createElement('button');
  addTabBtn.type = 'button';
  addTabBtn.className = 'sidebar-subitem sidebar-subitem-add';
  addTabBtn.textContent = '+ New tab';
  addTabBtn.addEventListener('click', () => addKraTab());
  tabsSubnav.appendChild(addTabBtn);

  tabsGroup.appendChild(tabsSubnav);
  top.appendChild(tabsGroup);

  // ---- Analytics: no sub-list, plain link. ----
  const analyticsBtn = document.createElement('button');
  analyticsBtn.type = 'button';
  analyticsBtn.id = 'analyticsBtn';
  analyticsBtn.className = `sidebar-item${activeWorkspace === 'charts' ? ' active' : ''}`;
  analyticsBtn.title = 'Analytics';
  analyticsBtn.innerHTML = '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="2" y="10" width="4" height="8" rx="1"/><rect x="8" y="5" width="4" height="13" rx="1"/><rect x="14" y="2" width="4" height="16" rx="1"/></svg><span class="nav-label">Analytics</span>';
  analyticsBtn.addEventListener('click', () => {
    activeWorkspace = 'charts';
    render();
  });
  top.appendChild(analyticsBtn);

  // ---- Productivity: no sub-list, plain link, same pattern as Analytics. ----
  const productivityBtn = document.createElement('button');
  productivityBtn.type = 'button';
  productivityBtn.id = 'productivityBtn';
  productivityBtn.className = `sidebar-item${activeWorkspace === 'productivity' ? ' active' : ''}`;
  productivityBtn.title = 'Reports';
  productivityBtn.innerHTML = '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2.5" width="12" height="15" rx="1.5"/><path d="M7.5 2.5V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v.5"/><path d="M7 9h6M7 11.8h6M7 14.6h3.5"/></svg><span class="nav-label">Reports</span>';
  productivityBtn.addEventListener('click', () => {
    activeWorkspace = 'productivity';
    render();
  });
  top.appendChild(productivityBtn);


  // ---- Bottom-pinned employee actions. ----
  const registerBtn = document.createElement('button');
  registerBtn.type = 'button';
  registerBtn.id = 'registerBtn';
  registerBtn.className = 'sidebar-item';
  registerBtn.title = 'Register employee';
  registerBtn.innerHTML = '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="7" r="3.2"/><path d="M2.5 17c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/><path d="M15.5 6.5v5M13 9h5"/></svg><span class="nav-label">Register employee</span>';
  registerBtn.addEventListener('click', () => openRegisterPopup());
  bottom.appendChild(registerBtn);

  const checkinBtn = document.createElement('button');
  checkinBtn.type = 'button';
  checkinBtn.id = 'checkinBtn';
  checkinBtn.className = 'sidebar-item';
  checkinBtn.title = 'Check in / Check out';
  checkinBtn.innerHTML = '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 5.5V10l3.2 2"/></svg><span class="nav-label">Check in/out</span>';
  checkinBtn.addEventListener('click', () => openAttendancePopup());
  bottom.appendChild(checkinBtn);

  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.id = 'leaveBtn';
  leaveBtn.className = 'sidebar-item';
  leaveBtn.title = 'Apply for leave';
  leaveBtn.innerHTML = '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="15" height="13" rx="1.5"/><path d="M2.5 8h15"/><path d="M6 2.5v3M14 2.5v3"/><path d="M7 12.5l2 2 4-4.5"/></svg><span class="nav-label">Apply for leave</span>';
  leaveBtn.addEventListener('click', () => openLeaveApplicationPopup());
  bottom.appendChild(leaveBtn);

  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.id = 'exitBtn';
  exitBtn.className = 'sidebar-item exit-btn';
  exitBtn.title = 'Employee exit';
  exitBtn.innerHTML = '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="2.6"/><path d="M3.5 17c0-3 2-5 4.5-5"/><path d="M12 8.5 16.5 13M16.5 8.5 12 13"/></svg><span class="nav-label">Employee exit</span>';
  exitBtn.addEventListener('click', () => openExitPopup());
  bottom.appendChild(exitBtn);
}

function fmtTimeShort(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// "Current status" always reads off the LATEST checkin/checkout today, not
// the first -- with re-check-in allowed (see openAttendancePopup), someone
// can have checkin/checkout/checkin/checkout... pairs in one day, and the
// card should reflect where they are right now, not this morning.
function getEmployeeAttendanceLabel(listName) {
  const emp = getRegisteredEmployees().find((e) => sameEmployee(e.name, listName));
  if (!emp) return null;
  const checkin = getLatestTodayActivity(emp.email, 'checkin');
  if (!checkin) return null;
  const checkout = getLatestTodayActivity(emp.email, 'checkout');
  const isCheckedIn = !checkout || checkin.timestamp > checkout.timestamp;
  if (isCheckedIn) return { text: `In ${fmtTimeShort(checkin.timestamp)}`, done: false };
  return { text: `${fmtTimeShort(checkin.timestamp)}–${fmtTimeShort(checkout.timestamp)}`, done: true };
}

// A check-in/check-out shortcut shown right on each employee's card, so
// their status is visible without opening the sidebar's Attendance popup.
// It's a shortcut INTO that popup, not a bypass of it — clicking always
// opens the same Google Sign-In-verified flow (openAttendancePopup) rather
// than logging activity directly, so a card can't be used to check someone
// else in/out without their own Google account confirming it.
function renderListAttendanceButton(list) {
  const emp = getRegisteredEmployees().find((e) => sameEmployee(e.name, list.name));
  if (!emp) return null;

  const checkin = getLatestTodayActivity(emp.email, 'checkin');
  const checkout = getLatestTodayActivity(emp.email, 'checkout');
  const isCheckedIn = Boolean(checkin) && (!checkout || checkin.timestamp > checkout.timestamp);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'list-attendance';

  if (!checkin) {
    btn.classList.add('checkin');
    btn.textContent = 'Check In';
    btn.title = `Check in ${emp.name || emp.email}`;
  } else if (isCheckedIn) {
    btn.textContent = `In ${fmtTimeShort(checkin.timestamp)}`;
    btn.title = `Check out ${emp.name || emp.email}`;
  } else {
    // Checked out, but re-checking in is allowed -- stays clickable
    // instead of disabling, unlike the old one-cycle-per-day behavior.
    btn.classList.add('checkin');
    btn.textContent = `Out ${fmtTimeShort(checkout.timestamp)} · Check In`;
    btn.title = `Check ${emp.name || emp.email} back in`;
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAttendancePopup(list.name);
  });

  return btn;
}

// Green once they've copied today's WhatsApp update for the CURRENT
// window (before/after 6 PM -- see COPY_STATUS_RESET_HOUR), red if
// they've checked in but haven't yet, gray if they haven't even checked
// in today (nothing to remind them of before that). Crossing 6 PM flips
// a green icon back to red on its own, since a morning-window copy no
// longer satisfies the evening window's check -- no separate "reset"
// step needed, it falls out of just checking which window the last copy
// actually landed in. Always copies regardless of employee/check-in
// status; the color tracking specifically needs a matched employee record
// to have anything to check against.
function renderListCopyStatusIcon(list) {
  const emp = getRegisteredEmployees().find((e) => sameEmployee(e.name, list.name));
  const checkin = emp ? getTodayActivity(emp.email, 'checkin') : null;
  const evening = isEveningUpdateWindow();

  let statusClass = 'none';
  if (emp && checkin) {
    const lastCopy = getLatestTodayActivity(emp.email, 'share_copied');
    const copiedThisWindow = Boolean(lastCopy) && isEveningUpdateWindow(new Date(lastCopy.timestamp)) === evening;
    statusClass = copiedThisWindow ? 'green' : 'red';
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `list-copy-status-btn ${statusClass}`;
  btn.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-8A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14H6"/></svg>';
  if (!emp) {
    btn.title = 'Copy today’s update in WhatsApp format';
  } else if (!checkin) {
    btn.title = `${emp.name || emp.email} hasn’t checked in yet today`;
  } else if (statusClass === 'green') {
    btn.title = `Copied for ${evening ? 'the evening' : 'the morning'} update`;
  } else {
    btn.title = `Not copied yet for ${evening ? 'the evening' : 'the morning'} update — click to copy`;
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyTextToClipboard(buildDailyUpdateShareText(list))
      .then(() => {
        if (emp) {
          state.activity = state.activity || [];
          state.activity.push({ id: uid('act'), type: 'share_copied', name: emp.name, email: emp.email, timestamp: Date.now(), ip: '', device: '' });
          persist();
        }
        showToast('Copied — paste it in WhatsApp or anywhere');
        render();
      })
      .catch(() => showToast('Could not copy to clipboard'));
  });

  return btn;
}

function renderPinnedState() {
  // analyticsBtn/kraBtn are rebuilt fresh (with the right .active class)
  // inside renderSidebar() on every render, so no toggling needed here.
  const archivedBtn = document.getElementById('archivedListsBtn');
  if (archivedBtn) {
    const archivedCount = getArchivedLists().length + getArchivedProjects().length;
    archivedBtn.textContent = archivedCount ? `Archived (${archivedCount})` : 'Archived';
    archivedBtn.classList.toggle('has-archived', archivedCount > 0);
  }
}

function renderNavItem({ id, name, count, active, overdue, progress = 0, color }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `nav-item${active ? ' active' : ''}`;
  btn.dataset.listId = id;
  if (color) btn.style.setProperty('--list-accent', color);
  btn.style.setProperty('--progress', `${progress}%`);

  const dot = document.createElement('span');
  dot.className = overdue ? 'nav-dot overdue' : 'nav-dot';
  btn.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'nav-label';
  label.textContent = name;
  btn.appendChild(label);

  const badge = document.createElement('span');
  badge.className = 'nav-badge';
  badge.textContent = count || '0';
  btn.appendChild(badge);

  btn.addEventListener('click', () => {
    activeWorkspace = 'tasks';
    activeListId = id;
    activeQuickPriority = 'any';
    activeQuickStatus = 'any';
    if (id === 'all') {
      activeRegularEmployee = 'all';
      activeProjectEmployee = 'all';
    } else {
      const employees = state.regular?.employees || [];
      const regularMatch = employees.find((e) => sameEmployee(e, name));
      activeRegularEmployee = regularMatch || name;
      const projectEmployees = getProjectEmployees();
      const projectMatch = projectEmployees.find((e) => sameEmployee(e, name));
      activeProjectEmployee = projectMatch || name;
    }
    render();
  });

  return btn;
}

function getQuickFilterLabel() {
  if (activeQuickPriority !== 'any') {
    return `${activeQuickPriority.charAt(0).toUpperCase()}${activeQuickPriority.slice(1)} priority`;
  }
  if (activeQuickStatus === 'overdue') return 'Overdue tasks';
  if (activeQuickStatus === 'done') return 'Completed tasks';
  if (activeQuickStatus === 'open') return 'Open tasks';
  return null;
}

function toggleQuickStatus(status) {
  activeQuickStatus = activeQuickStatus === status ? 'any' : status;
  activeQuickPriority = 'any';
  render();
}

function toggleQuickPriority(priority) {
  activeQuickPriority = activeQuickPriority === priority ? 'any' : priority;
  activeQuickStatus = 'any';
  render();
}

function renderStatCard(key, label, value) {
  const stat = document.createElement('button');
  stat.type = 'button';
  const isActive = activeQuickStatus === key;
  stat.className = `stat-card ${key}${isActive ? ' active' : ''}`;
  stat.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
  stat.addEventListener('click', () => toggleQuickStatus(key));
  return stat;
}

function openPriorityFilterMenu(anchorEl, { high, medium, low }) {
  document.querySelectorAll('.priority-filter-menu').forEach((m) => m.remove());

  const menu = document.createElement('div');
  menu.className = 'stat-card-dropdown priority-filter-menu open';

  [
    ['high', 'High priority', high],
    ['medium', 'Medium priority', medium],
    ['low', 'Low priority', low],
  ].forEach(([priority, priorityLabel, count]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = activeQuickPriority === priority ? 'active' : '';
    btn.innerHTML = `<span>${priorityLabel}</span><strong>${count}</strong>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      toggleQuickPriority(priority);
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'absolute';
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;
  menu.style.zIndex = '1000';

  const closeMenu = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorEl) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('scroll', closeOnScroll, true);
    }
  };
  // Positioned once relative to the page at open time, so a scroll on any
  // inner panel (not just the whole page) would leave it floating detached
  // from its anchor — closing on scroll avoids that instead of re-tracking.
  const closeOnScroll = () => {
    menu.remove();
    document.removeEventListener('click', closeMenu);
    document.removeEventListener('scroll', closeOnScroll, true);
  };
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('scroll', closeOnScroll, true);
  }, 0);
}

function renderPriorityStatCard({ high, medium, low }) {
  const activeLabel = activeQuickPriority !== 'any' ? activeQuickPriority : 'high';
  const activeValue = activeQuickPriority === 'medium' ? medium : activeQuickPriority === 'low' ? low : high;

  const stat = document.createElement('button');
  stat.type = 'button';
  // Use the active label to control color/class so styles update correctly
  stat.className = `stat-card ${activeLabel} priority-card${activeQuickPriority !== 'any' ? ' active' : ''}`;
  stat.innerHTML = `<span>${activeLabel.charAt(0).toUpperCase()}${activeLabel.slice(1)}</span><strong>${activeValue}</strong>`;

  const cycle = ['high', 'medium', 'low', 'any'];
  stat.addEventListener('click', (e) => {
    e.stopPropagation();
    // find current index and move to next
    const idx = cycle.indexOf(activeQuickPriority === 'any' ? 'any' : (activeQuickPriority || 'high'));
    const next = cycle[(idx + 1) % cycle.length];
    activeQuickPriority = next === 'any' ? 'any' : next;
    // reset status filter when changing priority
    activeQuickStatus = 'any';
    render();
  });

  return stat;
}

function renderDashboardHeader() {
  const visibleLists = getVisibleLists();
  const quickLabel = getQuickFilterLabel();
  dashboardTitleEl.textContent = quickLabel
    ? quickLabel
    : activeListId === 'all' ? 'All tasks' : (visibleLists[0] ? visibleLists[0].name : 'All tasks');
  statsEl.innerHTML = '';

  const rows = getAllTaskRowsUnfiltered(true);
  const open = rows.filter(({ task }) => !task.done).length;
  const done = rows.filter(({ task }) => task.done).length;
  const overdue = rows.filter(({ task }) => !task.done && task.due && task.due < todayStr()).length;
  const high = rows.filter(({ task }) => !task.done && task.priority === 'high').length;
  const medium = rows.filter(({ task }) => !task.done && task.priority === 'medium').length;
  const low = rows.filter(({ task }) => !task.done && task.priority === 'low').length;

  statsEl.appendChild(renderStatCard('open', 'Open', open));
  statsEl.appendChild(renderStatCard('overdue', 'Overdue', overdue));
  statsEl.appendChild(renderPriorityStatCard({ high, medium, low }));
  statsEl.appendChild(renderStatCard('done', 'Done', done));
}

function renderRegularDashboardHeader() {
  dashboardTitleEl.textContent = 'Regular Tasks';
  statsEl.innerHTML = '';
  const dates = getRegularDates();
  const tasks = getRegularTasks();
  const expectedCells = tasks.flatMap((task) => dates.filter((date) => isRegularTaskExpected(task, date)).map((date) => ({ task, date })));
  const done = expectedCells.filter(({ task, date }) => isRegularDone(task, date)).length;
  const today = todayStr();
  const todayPending = tasks.filter((task) => {
    const date = new Date(today);
    return isRegularTaskExpected(task, date) && !isRegularDone(task, date);
  }).length;
  [
    ['Tasks', tasks.length],
    ['Done', done],
    ['Pending today', todayPending],
    ['Progress', `${expectedCells.length ? Math.round((done / expectedCells.length) * 100) : 0}%`],
  ].forEach(([label, value]) => {
    const stat = document.createElement('div');
    stat.className = `stat-card ${label === 'Pending today' ? 'overdue' : 'open'}`;
    stat.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    statsEl.appendChild(stat);
  });
}

function renderRegularSection() {
  const section = document.createElement('section');
  section.className = 'regular-section';

  const header = document.createElement('div');
  header.className = 'section-header secondary';
  const title = document.createElement('h2');
  title.textContent = getActiveRegularSectionTitle();
  header.appendChild(title);

  const viewToggle = document.createElement('div');
  viewToggle.className = 'regular-view-toggle';
  [['grid', 'Grid'], ['calendar', 'Calendar']].forEach(([mode, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn small${regularViewMode === mode ? ' active' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (regularViewMode === mode) return;
      regularViewMode = mode;
      render();
    });
    viewToggle.appendChild(btn);
  });
  header.appendChild(viewToggle);
  section.appendChild(header);

  section.appendChild(renderRegularEmployeeSelector());

  if (regularViewMode === 'calendar') {
    section.appendChild(renderRegularCalendarView());
  } else {
    section.appendChild(renderRegularToolbar());
    section.appendChild(renderRegularGridView());
  }
  return section;
}

function getAttendanceDates() {
  return Array.from({ length: daysInMonth(attendanceMonth) }, (_, i) => addDays(attendanceMonth, i))
    .filter((date) => !isWeekend(date));
}

// Re-checking in after a checkout is allowed, so a day can have multiple
// checkin/checkout pairs -- pairs them up in order (1st checkin with 1st
// checkout, 2nd with 2nd, ...) since the popup only ever offers "Check In"
// when not currently checked in and "Check Out" when checked in, so the
// two lists naturally alternate. A trailing checkin with no matching
// checkout yet just means they're still checked in for that session.
function getAttendanceSessions(email, dateKeyStr) {
  const dayActivity = (state.activity || []).filter((a) => a.email === email && dateKey(new Date(a.timestamp)) === dateKeyStr);
  const checkins = dayActivity.filter((a) => a.type === 'checkin').sort((a, b) => a.timestamp - b.timestamp);
  const checkouts = dayActivity.filter((a) => a.type === 'checkout').sort((a, b) => a.timestamp - b.timestamp);
  const count = Math.max(checkins.length, checkouts.length);
  const sessions = [];
  for (let i = 0; i < count; i++) sessions.push({ checkin: checkins[i] || null, checkout: checkouts[i] || null });
  return sessions;
}

function getAttendanceRecord(email, dateKeyStr) {
  const sessions = getAttendanceSessions(email, dateKeyStr);
  if (!sessions.length) return { checkin: null, checkout: null };
  return { checkin: sessions[0].checkin, checkout: sessions[sessions.length - 1].checkout };
}

function renderAttendanceSection() {
  const section = document.createElement('section');
  section.className = 'regular-section attendance-section';

  const header = document.createElement('div');
  header.className = 'section-header secondary';
  const title = document.createElement('h2');
  title.textContent = 'Attendance';
  header.appendChild(title);

  const viewToggle = document.createElement('div');
  viewToggle.className = 'regular-view-toggle';
  [['grid', 'Grid'], ['calendar', 'Calendar']].forEach(([mode, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn small${attendanceViewMode === mode ? ' active' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (attendanceViewMode === mode) return;
      attendanceViewMode = mode;
      render();
    });
    viewToggle.appendChild(btn);
  });
  header.appendChild(viewToggle);
  section.appendChild(header);

  if (attendanceViewMode === 'calendar') {
    section.appendChild(renderAttendanceCalendarView());
  } else {
    section.appendChild(renderAttendanceToolbar());
    section.appendChild(renderAttendanceTable());
  }
  return section;
}

function renderAttendanceCalendarView() {
  const wrap = document.createElement('div');
  wrap.className = 'calendar-view-panel attendance-calendar-panel';

  wrap.appendChild(renderCalendarToolbar(attendanceMonth, (next) => {
    attendanceMonth = next;
    render();
  }));

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  const weekdayRow = document.createElement('div');
  weekdayRow.className = 'calendar-weekdays';
  WEEKDAYS.forEach((w) => {
    const cell = document.createElement('div');
    cell.textContent = w;
    weekdayRow.appendChild(cell);
  });
  grid.appendChild(weekdayRow);

  const days = document.createElement('div');
  days.className = 'calendar-days';

  const month = attendanceMonth;
  const startOfGrid = addDays(month, -month.getDay());
  const today = todayStr();
  const employees = getRegisteredEmployees();
  const maxPerDay = 4;

  for (let i = 0; i < 42; i++) {
    const date = addDays(startOfGrid, i);
    const key = dateKey(date);
    const inMonth = date.getMonth() === month.getMonth();

    const cell = document.createElement('div');
    cell.className = `calendar-cell${inMonth ? '' : ' outside'}${key === today ? ' today' : ''}`;

    const dayNum = document.createElement('div');
    dayNum.className = 'calendar-day-num';
    dayNum.textContent = date.getDate();
    cell.appendChild(dayNum);

    if (inMonth) {
      const dayRecords = employees
        .map((emp) => ({ emp, ...getAttendanceRecord(emp.email, key) }))
        .filter(({ checkin }) => checkin);

      dayRecords.slice(0, maxPerDay).forEach(({ emp, checkin, checkout }) => {
        const inTime = fmtTimeOnly(checkin.timestamp);
        const outTime = checkout ? fmtTimeOnly(checkout.timestamp) : null;
        const pill = document.createElement('div');
        pill.className = `calendar-pill attendance-calendar-pill${checkout ? ' checked-out' : ''}`;
        pill.title = `${emp.name || emp.email} — In ${inTime}${outTime ? `, Out ${outTime}` : ' (not checked out yet)'}`;
        pill.innerHTML = `
          <span class="attendance-pill-name">${escapeHtml(emp.name || emp.email)}</span>
          <span class="attendance-pill-times">
            <span class="attendance-time in">${inTime}</span><span class="attendance-pill-sep">–</span><span class="attendance-time out">${outTime || '—'}</span>
          </span>
        `;
        cell.appendChild(pill);
      });

      if (dayRecords.length > maxPerDay) {
        const more = document.createElement('div');
        more.className = 'calendar-more';
        more.textContent = `+${dayRecords.length - maxPerDay} more`;
        cell.appendChild(more);
      }
    }

    days.appendChild(cell);
  }

  grid.appendChild(days);
  wrap.appendChild(grid);
  return wrap;
}

function renderAttendanceToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'regular-toolbar';

  const month = document.createElement('strong');
  month.textContent = `${MONTHS[attendanceMonth.getMonth()]} ${attendanceMonth.getFullYear()}`;
  toolbar.appendChild(month);

  const actions = document.createElement('div');
  actions.className = 'regular-date-actions';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'btn';
  prevBtn.textContent = 'Prev';
  prevBtn.addEventListener('click', () => {
    attendanceMonth = firstDayOfMonth(addMonths(attendanceMonth, -1));
    render();
  });
  actions.appendChild(prevBtn);

  const thisMonthBtn = document.createElement('button');
  thisMonthBtn.type = 'button';
  thisMonthBtn.className = 'btn';
  thisMonthBtn.textContent = 'This month';
  thisMonthBtn.addEventListener('click', () => {
    attendanceMonth = firstDayOfMonth(new Date());
    render();
  });
  actions.appendChild(thisMonthBtn);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn';
  nextBtn.textContent = 'Next';
  nextBtn.addEventListener('click', () => {
    attendanceMonth = firstDayOfMonth(addMonths(attendanceMonth, 1));
    render();
  });
  actions.appendChild(nextBtn);

  toolbar.appendChild(actions);
  return toolbar;
}

function renderAttendanceTable() {
  const panel = document.createElement('div');
  panel.className = 'regular-grid-panel';
  const employees = getRegisteredEmployees();
  const dates = getAttendanceDates();

  if (!employees.length) {
    panel.appendChild(renderEmptyState('No registered employees yet.'));
    return panel;
  }

  const table = document.createElement('table');
  table.className = 'regular-grid attendance-grid';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Employee', 'Check In / Out'].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  dates.forEach((date) => {
    const th = document.createElement('th');
    th.className = isWeekend(date) ? 'weekend' : '';
    th.innerHTML = `<span>${date.getDate()}</span><small>${WEEKDAYS[date.getDay()].slice(0, 1)}</small>`;
    th.title = `${date.getDate()} ${MONTHS[date.getMonth()]} (${WEEKDAYS[date.getDay()]})`;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  employees.forEach((emp) => {
    const tr = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = emp.name || emp.email;
    tr.appendChild(nameCell);

    const labelCell = document.createElement('td');
    labelCell.innerHTML = '<div class="attendance-inout-label">Check In<br>Check Out</div>';
    tr.appendChild(labelCell);

    dates.forEach((date) => {
      const td = document.createElement('td');
      td.className = isWeekend(date) ? 'weekend' : '';
      const key = dateKey(date);
      const sessions = getAttendanceSessions(emp.email, key);
      const cellWrap = document.createElement('div');
      cellWrap.className = 'attendance-cell';
      // One in/out pair per session, stacked vertically -- a re-checked-in
      // day appends a new pair below the earlier one instead of overwriting it.
      (sessions.length ? sessions : [{ checkin: null, checkout: null }]).forEach((session, i) => {
        if (i > 0) {
          const divider = document.createElement('div');
          divider.className = 'attendance-session-divider';
          cellWrap.appendChild(divider);
        }
        const inLine = document.createElement('div');
        inLine.className = 'attendance-time in';
        inLine.textContent = session.checkin ? fmtTimeOnly(session.checkin.timestamp) : '—';
        const outLine = document.createElement('div');
        outLine.className = 'attendance-time out';
        outLine.textContent = session.checkout ? fmtTimeOnly(session.checkout.timestamp) : '—';
        cellWrap.appendChild(inLine);
        cellWrap.appendChild(outLine);
      });
      td.appendChild(cellWrap);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  return panel;
}

function renderActivitySection() {
  const section = document.createElement('section');
  section.className = 'regular-section activity-section';

  const header = document.createElement('div');
  header.className = 'section-header secondary';
  const title = document.createElement('h2');
  title.textContent = 'Notice board';
  header.appendChild(title);
  section.appendChild(header);

  // Lets the boss post an announcement/reply straight into the feed,
  // alongside the auto-generated check-in/leave entries -- always shown,
  // even before there's any activity yet.
  const composer = document.createElement('form');
  composer.className = 'activity-composer';
  const composerInput = document.createElement('input');
  composerInput.type = 'text';
  composerInput.className = 'activity-composer-input';
  composerInput.placeholder = 'Post an announcement…';
  composerInput.maxLength = 500;
  const composerBtn = document.createElement('button');
  composerBtn.type = 'submit';
  composerBtn.className = 'activity-composer-btn';
  composerBtn.textContent = 'Post';
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!composerInput.value.trim()) return;
    postAnnouncement(composerInput.value);
    composerInput.value = '';
  });
  composer.appendChild(composerInput);
  composer.appendChild(composerBtn);
  section.appendChild(composer);

  // share_copied entries exist purely to drive the copy-status icon's
  // color (see renderListCopyStatusIcon) -- they'd just be noise here,
  // one entry every time anyone copies their update.
  const activity = [...(state.activity || [])].filter((a) => a.type !== 'share_copied').sort((a, b) => b.timestamp - a.timestamp);

  if (!activity.length) {
    section.appendChild(renderEmptyState('No employee activity tracked yet.'));
    return section;
  }

  const ACTIVITY_LABELS = { register: 'registered', checkin: 'checked in', checkout: 'checked out', leave: 'applied for leave', exit: 'has exited', employee_restored: 'was restored (undo exit)' };
  const ACTIVITY_ICONS = { register: '📝', checkin: '➡️', checkout: '⬅️', leave: '🏖️', announcement: '📢', exit: '🚪', employee_restored: '♻️', task_created: '➕', project_created: '🗂️', due_changed: '📅', task_edited: '✏️', project_edited: '✏️', task_deleted: '🗑️', task_restored: '♻️', task_completed: '✅', project_completed: '🏁', regular_completed: '✅' };

  const list = document.createElement('div');
  list.className = 'activity-list';
  // Was capped at the 10 most recent -- now the whole history renders and
  // .activity-list scrolls instead, so nothing older silently vanishes.
  activity.forEach((entry) => {
    const row = document.createElement('div');
    row.className = `activity-row activity-${entry.type}`;

    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.textContent = ACTIVITY_ICONS[entry.type] || '•';
    row.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'activity-info';

    if (ACTIVITY_MESSAGE_TYPES.includes(entry.type)) {
      const line1 = document.createElement('div');
      line1.className = 'activity-main';
      line1.textContent = entry.text;
      info.appendChild(line1);

      const line2 = document.createElement('div');
      line2.className = 'activity-sub';
      line2.textContent = fmtDateTime(entry.timestamp);
      info.appendChild(line2);

      row.appendChild(info);

      // Only announcements are user-authored -- the others (task/project
      // created, due date changed) are system-generated audit entries, so
      // there's no delete button on those; deleting your own mistake is
      // one thing, deleting a record of what happened is another.
      if (entry.type === 'announcement') {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'activity-announcement-delete';
        delBtn.innerHTML = '&times;';
        delBtn.title = 'Delete announcement';
        delBtn.addEventListener('click', () => deleteAnnouncement(entry.id));
        row.appendChild(delBtn);
      }

      list.appendChild(row);
      return;
    }

    const line1 = document.createElement('div');
    line1.className = 'activity-main';
    const dayCount = entry.type === 'leave' && Array.isArray(entry.leaveDates) ? entry.leaveDates.length : 0;
    // Re-checking in after a checkout is allowed (unlimited sessions/day),
    // so flag repeats -- "checked in" on its own would otherwise read as
    // their only check-in of the day even on their 2nd or 3rd time.
    let repeatSuffix = '';
    if (entry.type === 'checkin' || entry.type === 'checkout') {
      const entryDay = dateKey(new Date(entry.timestamp));
      const sameDaySameType = activity
        .filter((a) => a.type === entry.type && a.email === entry.email && dateKey(new Date(a.timestamp)) === entryDay)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (sameDaySameType.length > 1) {
        const idx = sameDaySameType.findIndex((a) => a.id === entry.id);
        repeatSuffix = ` (${ordinal(idx + 1)} time)`;
      }
    }
    line1.textContent = `${entry.name || entry.email} ${ACTIVITY_LABELS[entry.type] || entry.type}${dayCount > 1 ? ` (${dayCount} days)` : ''}${repeatSuffix}`;
    info.appendChild(line1);

    const line2 = document.createElement('div');
    line2.className = 'activity-sub';
    if (entry.type === 'leave' && Array.isArray(entry.leaveDates)) {
      line2.textContent = entry.leaveDates
        .map((d) => `${formatDateStrForShare(d.date)}${d.reason ? ` (${d.reason})` : ''}`)
        .join(', ');
    } else {
      const parts = [fmtDateTime(entry.timestamp)];
      if (entry.name && entry.email) parts.push(entry.email);
      if (entry.ip) parts.push(`IP: ${entry.ip}`);
      if (entry.device) parts.push(shortenDevice(entry.device));
      line2.textContent = parts.join(' · ');
    }
    info.appendChild(line2);

    row.appendChild(info);
    list.appendChild(row);
  });
  section.appendChild(list);
  return section;
}

function renderProjectSection() {
  const section = document.createElement('section');
  section.className = 'project-section';

  const header = document.createElement('div');
  header.className = 'project-section-header';
  const title = document.createElement('h2');
  title.className = 'project-section-title';
  title.textContent = 'Projects';
  header.appendChild(title);
  section.appendChild(header);

  section.appendChild(renderProjectPersonBoard());
  return section;
}

function getProjectCardNames() {
  const names = getActiveLists().map((l) => l.name);
  // Excludes deleted projects -- an employee exit can leave a project
  // both ownerless and soft-deleted (its last owner just left), and
  // that alone shouldn't conjure up an "Unassigned" card just to show
  // a single leftover "Deleted" entry.
  const hasUnassigned = (state.projects || []).some((p) => !p.archived && !p.deleted && (!p.owners || !p.owners.length));
  if (hasUnassigned) names.push('Unassigned');

  // A project can be owned by someone who's no longer a registered
  // employee -- removed outside the normal Employee Exit flow (which
  // does clean this up), from before that feature existed, or a manual
  // data edit. Without this, that project has no card to render in at
  // all: it's still fully active data, just permanently invisible (and
  // so undeletable through the UI) since nothing before this loop ever
  // surfaces a name that isn't a current list.
  (state.projects || []).forEach((p) => {
    if (p.archived || p.deleted) return;
    (p.owners || []).forEach((owner) => {
      if (!names.some((n) => sameEmployee(n, owner))) names.push(owner);
    });
  });

  return names;
}

function getProjectsForPerson(name) {
  const visible = (state.projects || []).filter((p) => !p.archived);
  if (name === 'Unassigned') {
    return visible.filter((p) => !p.owners || !p.owners.length);
  }
  return visible.filter((p) => (p.owners || []).some((o) => sameEmployee(o, name)));
}

function renderProjectPersonBoard() {
  const panel = document.createElement('div');
  panel.className = 'project-board';
  const names = getProjectCardNames();

  if (!names.length) {
    panel.appendChild(renderEmptyState('No employees yet. Register someone or add a list to get started.'));
    return panel;
  }

  names.forEach((name) => panel.appendChild(renderProjectPersonCard(name)));
  return panel;
}

function renderProjectPersonCard(name) {
  const card = document.createElement('section');
  card.className = 'list-column project-person-card';
  card.style.setProperty('--list-accent', listAccentColor(name));
  makeResizable(card, `project-person:${name}`);

  const header = document.createElement('header');
  header.className = 'list-header';
  const nameEl = document.createElement('h2');
  nameEl.className = 'list-name';
  nameEl.textContent = name;
  header.appendChild(nameEl);

  const projects = getProjectsForPerson(name);
  const activeProjects = projects.filter((p) => !p.done && !p.deleted);
  const doneProjects = projects.filter((p) => p.done && !p.deleted);
  const deletedProjects = projects.filter((p) => p.deleted);

  const countEl = document.createElement('span');
  countEl.className = 'list-count';
  countEl.textContent = activeProjects.length || '';
  header.appendChild(countEl);

  // Completed/Deleted are small icon+count pills in the header (same
  // pattern as renderList's task cards) instead of full-width toggle rows,
  // so a card with nothing completed/deleted yet costs no extra space.
  const completedBtn = document.createElement('button');
  completedBtn.type = 'button';
  completedBtn.className = 'list-completed-btn';
  completedBtn.classList.toggle('hidden', doneProjects.length === 0);
  completedBtn.title = `${doneProjects.length} completed`;
  completedBtn.innerHTML = '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l3.5 3.5L16 5.5"/></svg><span></span>';
  completedBtn.querySelector('span').textContent = doneProjects.length;
  header.appendChild(completedBtn);

  const deletedBtn = document.createElement('button');
  deletedBtn.type = 'button';
  deletedBtn.className = 'list-deleted-btn';
  deletedBtn.classList.toggle('hidden', deletedProjects.length === 0);
  deletedBtn.title = `${deletedProjects.length} deleted`;
  deletedBtn.innerHTML = '<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6M6 6l.5 9a1 1 0 0 0 1 .9h5a1 1 0 0 0 1-.9L14 6"/></svg><span></span>';
  deletedBtn.querySelector('span').textContent = deletedProjects.length;
  header.appendChild(deletedBtn);

  if (name !== 'Unassigned' && activeProjects.length) {
    const menuWrap = document.createElement('div');
    menuWrap.className = 'list-menu-wrap';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'icon-btn list-menu-btn';
    menuBtn.title = 'Project options';
    menuBtn.innerHTML = '&#8942;';
    menuWrap.appendChild(menuBtn);

    const menu = document.createElement('div');
    menu.className = 'list-menu hidden';

    const copyBtn = document.createElement('button');
    copyBtn.dataset.action = 'copy-projects';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.add('hidden');
      copyTextToClipboard(buildProjectsShareText(name, activeProjects))
        .then(() => showToast('Copied – paste it in WhatsApp or anywhere'))
        .catch(() => showToast('Could not copy to clipboard'));
    });
    menu.appendChild(copyBtn);

    const archiveBtn = document.createElement('button');
    archiveBtn.dataset.action = 'archive-projects';
    archiveBtn.textContent = 'Archive all projects';
    archiveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const toArchive = activeProjects.slice();
      toArchive.forEach((p) => { p.archived = true; p.archivedAt = Date.now(); });
      persist();
      render();
      showToast(`Archived ${toArchive.length} project${toArchive.length === 1 ? '' : 's'} for "${name}" – find them under Archived to restore`, () => {
        toArchive.forEach((p) => { p.archived = false; p.archivedAt = null; });
        persist();
        render();
      });
      menu.classList.add('hidden');
    });
    menu.appendChild(archiveBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.dataset.action = 'delete-projects';
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete all projects';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (deleteBtn.dataset.armed === '1') {
        const toDelete = activeProjects.slice();
        toDelete.forEach((p) => { p.deleted = true; p.deletedAt = Date.now(); });
        persist();
        render();
        showToast(`Deleted ${toDelete.length} project${toDelete.length === 1 ? '' : 's'} for "${name}"`, () => {
          toDelete.forEach((p) => { p.deleted = false; delete p.deletedAt; });
          persist();
          render();
        });
        menu.classList.add('hidden');
      } else {
        deleteBtn.dataset.armed = '1';
        deleteBtn.textContent = 'Click again to confirm';
        setTimeout(() => {
          deleteBtn.dataset.armed = '0';
          deleteBtn.textContent = 'Delete all projects';
        }, 3000);
      }
    });
    menu.appendChild(deleteBtn);

    menuWrap.appendChild(menu);
    header.appendChild(menuWrap);

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.list-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
      menu.classList.toggle('hidden');
    });
  }

  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tasks-list unsectioned';
  if (!activeProjects.length) {
    body.appendChild(renderProjectEmptyState(name));
  } else {
    activeProjects.forEach((project) => body.appendChild(renderProjectRow(project)));
  }
  card.appendChild(body);

  const wrap = document.createElement('div');
  wrap.className = 'completed-wrap hidden';
  const list = document.createElement('div');
  list.className = 'completed-list tasks-list';
  doneProjects
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .forEach((project) => list.appendChild(renderProjectRow(project)));
  wrap.appendChild(list);
  completedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.toggle('hidden');
    completedBtn.classList.toggle('active', !wrap.classList.contains('hidden'));
  });
  card.appendChild(wrap);

  const delWrap = document.createElement('div');
  delWrap.className = 'deleted-wrap hidden';
  const delList = document.createElement('div');
  delList.className = 'deleted-list';
  deletedProjects
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
    .forEach((project) => delList.appendChild(renderDeletedProjectRow(project)));
  delWrap.appendChild(delList);
  deletedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    delWrap.classList.toggle('hidden');
    deletedBtn.classList.toggle('active', !delWrap.classList.contains('hidden'));
  });
  card.appendChild(delWrap);

  return card;
}

// Only shown for entries that had actual progress on them at the moment
// they were deleted -- a task/project deleted at 0% progress cost nothing
// real, so there's nothing worth asking about. Deletion itself stays
// instant/uninterrupted; this is tagged afterward, whenever convenient,
// directly in the Deleted list. Clicking the active reason again clears it
// back to untagged rather than forcing a choice.
function renderDeleteReasonPicker(progress, currentReason, onSetReason) {
  if (!(progress > 0)) return null;
  const wrap = document.createElement('div');
  wrap.className = 'delete-reason-picker';

  const label = document.createElement('span');
  label.className = 'delete-reason-label';
  label.textContent = 'Why?';
  wrap.appendChild(label);

  DELETE_REASONS.forEach((value) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `delete-reason-btn ${value}${currentReason === value ? ' active' : ''}`;
    btn.textContent = DELETE_REASON_LABELS[value];
    btn.title = value === 'abandoned' ? 'Counts toward the Waste score' : "Doesn't count toward the Waste score";
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSetReason(currentReason === value ? null : value);
    });
    wrap.appendChild(btn);
  });

  return wrap;
}

function renderDeletedProjectRow(project) {
  const row = document.createElement('div');
  row.className = 'deleted-task-row';
  
  const textEl = document.createElement('div');
  textEl.className = 'deleted-task-text';
  textEl.textContent = project.name;
  row.appendChild(textEl);
  
  const actions = document.createElement('div');
  actions.className = 'deleted-task-actions';
  
  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'icon-btn';
  restoreBtn.innerHTML = '&#8634;'; // undo icon
  restoreBtn.title = 'Restore project';
  restoreBtn.addEventListener('click', () => {
    project.deleted = false;
    delete project.deletedAt;
    persist();
    render();
  });
  actions.appendChild(restoreBtn);
  
  const permBtn = document.createElement('button');
  permBtn.type = 'button';
  permBtn.className = 'icon-btn';
  permBtn.innerHTML = '&times;';
  permBtn.title = 'Permanently delete';
  permBtn.addEventListener('click', () => {
    permanentlyDeleteProject(project);
  });
  actions.appendChild(permBtn);

  row.appendChild(actions);

  const reasonPicker = renderDeleteReasonPicker(itemDisplayProgress(project), project.deleteReason, (value) => {
    project.deleteReason = value;
    persist();
    render();
  });
  if (reasonPicker) row.appendChild(reasonPicker);

  return row;
}

function permanentlyDeleteProject(project) {
  if (!confirm(`Permanently delete project "${project.name}"?`)) return;
  const idx = state.projects.findIndex((p) => p.id === project.id);
  if (idx === -1) return;
  state.projects.splice(idx, 1);
  persist();
  render();
}

function deleteProject(project) {
  project.deleted = true;
  project.deletedAt = Date.now();
  persist();
  render();
  showToast(`Deleted "${project.name}"`, () => {
    project.deleted = false;
    delete project.deletedAt;
    persist();
    render();
  });
}

function openProjectDatePicker(project, dueEl) {
  const input = document.createElement('input');
  input.type = 'date';
  input.value = project.dueDate || '';
  input.style.position = 'absolute';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const newDue = input.value || null;
    const oldDue = project.dueDate;
    if (newDue !== oldDue) {
      project.dueDate = newDue;
      logBoardEvent('due_changed', `Due date changed on "${project.name}": ${oldDue || 'none'} → ${newDue || 'none'}`);
      persist();
      render();
    }
    input.remove();
  });
  input.addEventListener('blur', () => setTimeout(() => input.remove(), 200));
  if (input.showPicker) input.showPicker(); else input.click();
}

function renderProjectRow(project) {
  const node = tplTask.content.firstElementChild.cloneNode(true);
  node.classList.add('project-row');
  if (project.done) node.classList.add('done');

  const checkBtn = node.querySelector('.task-check');
  checkBtn.title = project.done ? 'Restore project (undo)' : 'Mark project done';
  checkBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasDone = project.done;
    project.done = !project.done;
    project.completedAt = project.done ? Date.now() : null;
    project.progress = project.done ? 100 : (project.progress === 100 ? 0 : project.progress);
    if (project.done && !wasDone) logBoardEvent('project_completed', `Project completed: "${project.name}"`);
    persist();
    render();
  });

  const progress = itemDisplayProgress(project);
  const barEl = node.querySelector('.task-progress-bar');
  attachFluidProgressDrag(barEl, progress, (val) => {
    setProjectProgress(project, val);
  });

  const priorityEl = node.querySelector('.task-priority');
  priorityEl.classList.add(project.priority || 'none');
  priorityEl.textContent = project.priority === 'high' ? 'High' : project.priority === 'medium' ? 'Med' : project.priority === 'low' ? 'Low' : '';
  priorityEl.title = 'Click to cycle priority';
  priorityEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = PRIORITY_ORDER.indexOf(project.priority || 'none');
    project.priority = PRIORITY_ORDER[(idx + 1) % PRIORITY_ORDER.length];
    persist();
    render();
  });

  const textEl = node.querySelector('.task-text');
  textEl.textContent = project.name;
  textEl.contentEditable = !project.done;



  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); textEl.textContent = project.name; textEl.blur(); }
  });
  textEl.addEventListener('blur', () => {
    const val = textEl.textContent.trim();
    if (!val) { textEl.textContent = project.name; return; }
    if (val !== project.name) { project.name = val; persist(); }
  });

  const copyBtn = node.querySelector('.task-copy');
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyTextToClipboard(buildSingleItemShareText(project, true))
      .then(() => showToast('Copied — paste it in WhatsApp or anywhere'))
      .catch(() => showToast('Could not copy to clipboard'));
  });

  const duplicateBtn = node.querySelector('.task-duplicate');
  duplicateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openItemPopup(project, true, '', '', true);
  });

  if (project.description) {
    const descEl = document.createElement('div');
    descEl.className = 'task-description';
    descEl.textContent = project.description;
    node.querySelector('.task-body').insertBefore(descEl, node.querySelector('.task-meta'));
  }

  const deleteBtn = node.querySelector('.task-delete');
  deleteBtn.addEventListener('click', () => deleteProject(project));

  const dueEl = node.querySelector('.task-due');
  const { text: dueText, cls: dueCls } = dueLabel(project.dueDate, project);
  dueEl.textContent = dueText;
  dueEl.className = `task-due ${dueCls}`;
  dueEl.addEventListener('click', () => openProjectDatePicker(project, dueEl));

  const createdEl = node.querySelector('.task-created');
  createdEl.textContent = project.done && project.completedAt
    ? formatCompletedDate(project.completedAt)
    : (project.startDate ? `Start ${fmtShort(new Date(`${project.startDate}T00:00:00`).getTime())}` : '');

  const statusEl = node.querySelector('.task-status');
  statusEl.className = `task-status ${statusSlug(project.status)}`;
  statusEl.textContent = normalizeStatusValue(project.status);
  statusEl.title = 'Click to change status';
  statusEl.addEventListener('click', (e) => {
    e.stopPropagation();
    project.status = nextStatus(project.status);
    persist();
    render();
  });

  node.querySelector('.task-meta').appendChild(renderCategoryChip(project, (value) => {
    project.category = value;
    persist();
    render();
  }));

  const editBtn = node.querySelector('.task-edit');
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openItemPopup(project, true);
  });

  const fragment = document.createDocumentFragment();
  fragment.appendChild(node);
  if ((project.tasks || []).length) {
    const subtaskList = document.createElement('div');
    subtaskList.className = 'project-subtask-list';
    project.tasks.forEach((task) => subtaskList.appendChild(renderProjectSubtaskRow(project, task)));
    fragment.appendChild(subtaskList);
  }
  return fragment;
}

function renderProjectSubtaskRow(project, task) {
  const row = document.createElement('div');
  row.className = 'project-subtask-row';
  if (task.done) row.classList.add('done');

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'project-subtask-check';
  check.title = task.done ? 'Restore task (undo)' : 'Mark done';
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasDone = task.done;
    task.done = !task.done;
    task.completedAt = task.done ? Date.now() : null;
    if (task.done && !wasDone) logBoardEvent('task_completed', `Task completed: "${task.text}" (${project.name})`);
    persist();
    render();
  });
  row.appendChild(check);

  const priorityEl = document.createElement('span');
  priorityEl.className = `task-priority ${task.priority || 'none'}`;
  priorityEl.textContent = task.priority === 'high' ? 'High' : task.priority === 'medium' ? 'Med' : task.priority === 'low' ? 'Low' : '';
  priorityEl.title = 'Click to cycle priority';
  priorityEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = PRIORITY_ORDER.indexOf(task.priority || 'none');
    task.priority = PRIORITY_ORDER[(idx + 1) % PRIORITY_ORDER.length];
    persist();
    render();
  });
  row.appendChild(priorityEl);

  const body = document.createElement('div');
  body.className = 'project-subtask-body';

  const text = document.createElement('span');
  text.className = 'project-subtask-text';
  text.textContent = task.text;
  text.contentEditable = !task.done;
  text.spellcheck = false;
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); text.textContent = task.text; text.blur(); }
  });
  text.addEventListener('blur', () => {
    const val = text.textContent.trim();
    if (!val) { text.textContent = task.text; return; }
    if (val !== task.text) { task.text = val; persist(); }
  });
  body.appendChild(text);

  if (task.description) {
    const desc = document.createElement('div');
    desc.className = 'project-subtask-desc';
    desc.textContent = task.description;
    body.appendChild(desc);
  }

  row.appendChild(body);

  // Was missing entirely -- there was no way to edit a project subtask's
  // due date/category/status/etc, only its text inline. openItemPopup
  // mutates whatever object reference it's given via Object.assign, so
  // this correctly edits the task in place inside project.tasks without
  // needing a project-specific save path.
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'icon-btn project-subtask-edit';
  editBtn.innerHTML = '&#9998;';
  editBtn.title = 'Edit task';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openItemPopup(task, false);
  });
  row.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'project-subtask-delete';
  delBtn.innerHTML = '&times;';
  delBtn.title = 'Delete task';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    project.tasks = project.tasks.filter((t) => t.id !== task.id);
    persist();
    render();
  });
  row.appendChild(delBtn);

  return row;
}

// `duplicateMode` opens the same form pre-filled from `existingItem` (name,
// priority, dates, category, status, description) but as a genuinely NEW
// item -- assignee left blank for the user to pick, saving creates a fresh
// task/project rather than touching the original. Lets "assign the same
// task to someone else" go through the real add flow (reviewable/editable
// before saving) instead of a silent duplicate.
function openItemPopup(existingItem = null, existingIsProject = false, presetAssignee = '', presetDueDate = '', duplicateMode = false) {
  document.querySelectorAll('.item-popup-overlay').forEach((m) => m.remove());
  const isEdit = Boolean(existingItem) && !duplicateMode;
  const isProjectItem = isEdit ? existingIsProject : false;
  const isDuplicate = Boolean(existingItem) && duplicateMode;
  const duplicateIsProject = isDuplicate && existingIsProject;

  const overlay = document.createElement('div');
  overlay.className = 'item-popup-overlay';

  const popup = document.createElement('div');
  popup.className = 'item-popup';
  popup.style.maxWidth = '480px';
  popup.style.maxHeight = '92vh';

  const employees = getAllEmployees();
  const titleText = isEdit ? `Edit ${isProjectItem ? 'Project' : 'Task'}` : (isDuplicate ? 'Duplicate Task/Project' : 'Add New Task/Project');

  popup.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 14px;">
      <h2 style="margin: 0; font-size: 17px; font-weight: 600;">${titleText}</h2>
      <div style="display: flex; gap: 8px; flex: 0 0 auto;">
        <button type="button" id="cancelItemBtn" style="padding: 7px 16px; border: 1px solid #ddd; border-radius: 999px; background: white; cursor: pointer; font-size: 13px; font-weight: 500;">Cancel</button>
        <button type="button" id="saveItemBtn" style="padding: 7px 18px; border: none; border-radius: 999px; background: #FFA500; color: white; cursor: pointer; font-size: 13px; font-weight: 600; box-shadow: 0 2px 8px rgba(255, 165, 0, 0.35);">${isEdit ? 'Save Changes' : 'Add'}</button>
      </div>
    </div>

    <div class="popup-2col" style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 10px; margin-bottom: 10px;">
      <div>
        <label style="${FIELD_LABEL_STYLE}">Assigned To</label>
        <div id="assignedToBox">
          <div id="assignedToChips" style="display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 34px; padding: 4px 6px; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box;">
            <input type="text" id="assignedToInput" placeholder="Type a name…" autocomplete="off" style="flex: 1; min-width: 70px; border: none; outline: none; font-size: 13px; padding: 3px;">
          </div>
        </div>
      </div>
      <div>
        <label style="${FIELD_LABEL_STYLE}">Priority</label>
        <div style="display: flex; gap: 5px;">
          <button type="button" class="item-priority-btn" data-priority="low" title="Low" style="flex: 1; padding: 7px; border: 2px solid #ddd; border-radius: 6px; background: white; cursor: pointer; font-size: 12.5px; font-weight: 600; color: #6C8BC4;">Low</button>
          <button type="button" class="item-priority-btn" data-priority="medium" title="Medium" style="flex: 1; padding: 7px; border: 2px solid #ddd; border-radius: 6px; background: white; cursor: pointer; font-size: 12.5px; font-weight: 600; color: #B36A00;">Medium</button>
          <button type="button" class="item-priority-btn" data-priority="high" title="High" style="flex: 1; padding: 7px; border: 2px solid #ddd; border-radius: 6px; background: white; cursor: pointer; font-size: 12.5px; font-weight: 600; color: #E04858;">High</button>
        </div>
      </div>
    </div>

    <div class="popup-2col" style="display: grid; grid-template-columns: 1.4fr 1fr; gap: 10px; margin-bottom: 10px;">
      <div>
        <label style="${FIELD_LABEL_STYLE}">Task/Project Name *</label>
        <input type="text" id="itemName" placeholder="Enter a name" style="${FIELD_STYLE}">
      </div>
      <div style="${isEdit ? 'visibility: hidden;' : ''}">
        <label style="${FIELD_LABEL_STYLE}">Add to Task/Project</label>
        <select id="itemProjectSelect" style="${FIELD_STYLE} cursor: pointer;">
          <option value="">Main List</option>
          <option value="__new__">+ New Project</option>
          ${(state.projects || []).filter(p => !p.deleted && !p.archived).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
        </select>
      </div>
    </div>

    <div style="margin-bottom: 10px;">
      <label style="${FIELD_LABEL_STYLE}">Description</label>
      <textarea id="itemDescription" placeholder="Optional details" style="${FIELD_STYLE} min-height: 36px; font-family: inherit;"></textarea>
    </div>

    <div class="popup-2col" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
      <div>
        <label style="${FIELD_LABEL_STYLE}">Start Date</label>
        <input type="date" id="itemStartDate" style="${FIELD_STYLE}">
      </div>
      <div>
        <label style="${FIELD_LABEL_STYLE}">Due Date</label>
        <input type="date" id="itemDueDate" style="${FIELD_STYLE}">
      </div>
    </div>

    <div class="popup-2col" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px;">
      <div>
        <label style="${FIELD_LABEL_STYLE}">Category</label>
        <input type="text" id="itemCategory" placeholder="Type or select…" autocomplete="off" style="${FIELD_STYLE}">
      </div>
      <div>
        <label style="${FIELD_LABEL_STYLE}">Status</label>
        <select id="itemStatus" style="${FIELD_STYLE}">${STATUS_OPTIONS.map((opt) => `<option value="${opt}">${opt}</option>`).join('')}</select>
      </div>
    </div>

  `;

  overlay.appendChild(popup);
  document.body.appendChild(overlay);

  let selectedPriority = existingItem ? (existingItem.priority || 'none') : 'none';
  const priorityBtns = popup.querySelectorAll('.item-priority-btn');
  priorityBtns.forEach((btn) => {
    if (btn.dataset.priority === selectedPriority) btn.style.borderColor = '#1F4690';
    btn.addEventListener('click', () => {
      priorityBtns.forEach((b) => (b.style.borderColor = '#ddd'));
      btn.style.borderColor = '#1F4690';
      selectedPriority = btn.dataset.priority;
    });
  });

  // ---- Assigned To: multi-select chip combobox with typeahead ----
  let selectedAssignees = isEdit
    ? (isProjectItem ? [...(existingItem.owners || [])] : (existingItem.assignedTo ? [existingItem.assignedTo] : []))
    : (presetAssignee ? [presetAssignee] : []);

  const assignedToBox = popup.querySelector('#assignedToBox');
  const assignedToInput = popup.querySelector('#assignedToInput');
  const assignedToChips = popup.querySelector('#assignedToChips');

  const assignedToSuggestions = document.createElement('div');
  assignedToSuggestions.className = 'combo-suggestions';
  assignedToSuggestions.style.cssText = 'position:fixed;max-height:140px;z-index:1100;display:none;';
  document.body.appendChild(assignedToSuggestions);

  function positionSuggestions(box, dropdown) {
    const rect = box.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 2}px`;
    dropdown.style.width = `${rect.width}px`;
  }

  function renderAssigneeChips() {
    assignedToChips.querySelectorAll('.assignee-chip').forEach((el) => el.remove());
    selectedAssignees.forEach((name) => {
      const chip = document.createElement('span');
      chip.className = 'assignee-chip';
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:rgba(31,70,144,0.1);color:#1F4690;padding:2px 6px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap;';
      chip.textContent = name;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.style.cssText = 'border:none;background:transparent;cursor:pointer;font-size:13px;line-height:1;color:inherit;padding:0;margin-left:2px;';
      rm.addEventListener('click', () => {
        selectedAssignees = selectedAssignees.filter((n) => n !== name);
        renderAssigneeChips();
      });
      chip.appendChild(rm);
      assignedToChips.insertBefore(chip, assignedToInput);
    });
  }
  renderAssigneeChips();

  function showAssigneeSuggestions() {
    const q = assignedToInput.value.trim().toLowerCase();
    const matches = employees.filter((e) => !selectedAssignees.includes(e) && (!q || e.toLowerCase().includes(q)));
    if (!matches.length) { assignedToSuggestions.style.display = 'none'; return; }
    assignedToSuggestions.innerHTML = matches.map((e) => `<div class="assignee-suggestion" data-name="${escapeHtml(e)}" style="padding:6px 10px;cursor:pointer;font-size:13px;">${escapeHtml(e)}</div>`).join('');
    assignedToSuggestions.scrollTop = 0;
    positionSuggestions(assignedToBox, assignedToSuggestions);
    assignedToSuggestions.style.display = 'block';
  }

  function pickAssignee(name) {
    if (!selectedAssignees.includes(name)) selectedAssignees.push(name);
    assignedToInput.value = '';
    renderAssigneeChips();
    showAssigneeSuggestions();
  }

  assignedToInput.addEventListener('focus', showAssigneeSuggestions);
  assignedToInput.addEventListener('input', showAssigneeSuggestions);
  assignedToSuggestions.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const target = e.target.closest('.assignee-suggestion');
    if (target) pickAssignee(target.dataset.name);
  });
  assignedToInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const firstMatch = assignedToSuggestions.querySelector('.assignee-suggestion');
      if (firstMatch) pickAssignee(firstMatch.dataset.name);
    }
    if (e.key === 'Backspace' && !assignedToInput.value && selectedAssignees.length) {
      selectedAssignees.pop();
      renderAssigneeChips();
    }
  });

  // ---- Category: type-to-filter, type-to-create combobox (no separate popup) ----
  const categoryInput = popup.querySelector('#itemCategory');

  const categorySuggestions = document.createElement('div');
  categorySuggestions.className = 'combo-suggestions';
  categorySuggestions.style.cssText = 'position:fixed;max-height:140px;z-index:1100;display:none;';
  document.body.appendChild(categorySuggestions);

  function showCategorySuggestions() {
    const q = categoryInput.value.trim().toLowerCase();
    const matches = state.categories.filter((c) => !q || c.toLowerCase().includes(q));
    if (!matches.length) { categorySuggestions.style.display = 'none'; return; }
    categorySuggestions.innerHTML = matches.map((c) => `<div class="category-suggestion" data-value="${escapeHtml(c)}" style="padding:6px 10px;cursor:pointer;font-size:13px;">${escapeHtml(c)}</div>`).join('');
    categorySuggestions.scrollTop = 0;
    positionSuggestions(categoryInput, categorySuggestions);
    categorySuggestions.style.display = 'block';
  }
  categoryInput.addEventListener('focus', showCategorySuggestions);
  categoryInput.addEventListener('input', showCategorySuggestions);
  categorySuggestions.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const target = e.target.closest('.category-suggestion');
    if (target) {
      categoryInput.value = target.dataset.value;
      categorySuggestions.style.display = 'none';
    }
  });
  categoryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); categorySuggestions.style.display = 'none'; }
  });

  const closeSuggestionsOnOutsideClick = (e) => {
    if (!assignedToBox.contains(e.target) && !assignedToSuggestions.contains(e.target)) assignedToSuggestions.style.display = 'none';
    if (!categoryInput.parentElement.contains(e.target) && !categorySuggestions.contains(e.target)) categorySuggestions.style.display = 'none';
  };
  const hideSuggestionsOnScroll = (e) => {
    if (e.target === assignedToSuggestions || e.target === categorySuggestions) return;
    assignedToSuggestions.style.display = 'none';
    categorySuggestions.style.display = 'none';
  };
  document.addEventListener('mousedown', closeSuggestionsOnOutsideClick);
  window.addEventListener('scroll', hideSuggestionsOnScroll, true);

  if (isEdit) {
    popup.querySelector('#itemName').value = isProjectItem ? existingItem.name : existingItem.text;
    popup.querySelector('#itemDescription').value = existingItem.description || '';
    popup.querySelector('#itemStartDate').value = existingItem.startDate || '';
    popup.querySelector('#itemDueDate').value = isProjectItem ? (existingItem.dueDate || '') : (existingItem.due || '');
    popup.querySelector('#itemStatus').value = normalizeStatusValue(existingItem.status);
    categoryInput.value = existingItem.category || '';
  } else if (isDuplicate) {
    popup.querySelector('#itemName').value = duplicateIsProject ? existingItem.name : existingItem.text;
    popup.querySelector('#itemDescription').value = existingItem.description || '';
    popup.querySelector('#itemStartDate').value = existingItem.startDate || '';
    popup.querySelector('#itemDueDate').value = duplicateIsProject ? (existingItem.dueDate || '') : (existingItem.due || '');
    popup.querySelector('#itemStatus').value = normalizeStatusValue(existingItem.status);
    categoryInput.value = existingItem.category || '';
    if (duplicateIsProject) popup.querySelector('#itemProjectSelect').value = '__new__';
  } else if (presetDueDate) {
    popup.querySelector('#itemDueDate').value = presetDueDate;
  }

  function closePopup() {
    document.removeEventListener('mousedown', closeSuggestionsOnOutsideClick);
    window.removeEventListener('scroll', hideSuggestionsOnScroll, true);
    assignedToSuggestions.remove();
    categorySuggestions.remove();
    overlay.remove();
  }

  popup.querySelector('#cancelItemBtn').addEventListener('click', () => closePopup());

  popup.querySelector('#saveItemBtn').addEventListener('click', () => {
    const name = popup.querySelector('#itemName').value.trim();
    if (!name) {
      alert('Please enter a name');
      return;
    }

    const startDate = popup.querySelector('#itemStartDate').value || null;
    const dueDate = popup.querySelector('#itemDueDate').value || null;
    const category = categoryInput.value.trim();
    if (category && !state.categories.some((c) => c.toLowerCase() === category.toLowerCase())) {
      state.categories.push(category);
    }
    const status = popup.querySelector('#itemStatus').value;
    const description = popup.querySelector('#itemDescription').value.trim();
    const projectSelect = popup.querySelector('#itemProjectSelect').value;
    const assignedTo = selectedAssignees[0] || '';

    // Handle project selection
    if (projectSelect === '__new__') {
      // Create new project and add task to it
      const newProject = {
        id: uid('proj'),
        name: name,
        owner: selectedAssignees[0] || 'Unassigned',
        owners: [...selectedAssignees],
        description,
        startDate,
        dueDate,
        priority: selectedPriority,
        status,
        category,
        sections: [],
        tasks: [],
        archived: false,
        archivedAt: null,
        deleted: false,
        deletedAt: null,
        deleteReason: null,
        mood: 'neutral',
        done: false,
        completedAt: null,
        progress: 0,
      };
      state.projects.push(newProject);
      logBoardEvent('project_created', `Project created: "${name}"`);
      persist();
      closePopup();
      render();
      return;
    } else if (projectSelect) {
      // Add task to existing project
      const project = state.projects.find(p => p.id === projectSelect);
      if (project) {
        const newTask = {
          id: uid('task'),
          text: name,
          description,
          startDate,
          due: dueDate,
          priority: selectedPriority,
          status,
          category,
          assignedTo,
          mood: 'neutral',
          done: false,
          completedAt: null,
          sectionId: null,
          dueChangeCount: 0,
          createdAt: Date.now(),
          progress: 0,
        };
        project.tasks.push(newTask);
        logBoardEvent('task_created', `Task added: "${name}" (${project.name})`);
        persist();
        closePopup();
        render();
        return;
      }
    }

    // Default: add to main list as regular task (when projectSelect is empty string)
    const activeLists = getActiveLists();
    if (!isEdit && !activeLists.length) {
      alert('Please create a list first before adding tasks.');
      return;
    }
    if (isEdit) {
      if (isProjectItem) {
        const oldName = existingItem.name;
        const projectData = {
          name,
          description,
          startDate,
          dueDate,
          priority: selectedPriority,
          owners: [...selectedAssignees],
          owner: selectedAssignees[0] || 'Unassigned',
          status,
          category,
        };
        Object.assign(existingItem, projectData);
        logBoardEvent('project_edited', oldName !== name ? `Project renamed: "${oldName}" → "${name}"` : `Project edited: "${name}"`);
      } else {
        const oldText = existingItem.text;
        const taskData = {
          text: name,
          description,
          startDate,
          due: dueDate,
          priority: selectedPriority,
          assignedTo,
          status,
          category,
        };
        Object.assign(existingItem, taskData);
        logBoardEvent('task_edited', oldText !== name ? `Task renamed: "${oldText}" → "${name}"` : `Task edited: "${name}"`);
      }
      persist();
      closePopup();
      render();
    } else {
      const targetList = activeListId !== 'all' ? findList(activeListId) : activeLists[0];
      // With multiple people selected, add a separate copy of this task to
      // each person's own list (mirrors how a multi-owner project shows up
      // in every owner's project card) — a task can only live in one list,
      // so this is the closest equivalent to "appending" it to everyone.
      const assignees = selectedAssignees.length ? selectedAssignees : [''];
      assignees.forEach((who) => {
        addTask(targetList, null, {
          text: name,
          description,
          startDate,
          due: dueDate,
          priority: selectedPriority,
          assignedTo: who,
          status,
          category,
        });
      });
      persist();
      closePopup();
      render();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePopup();
  });

  setTimeout(() => popup.querySelector('#itemName').focus(), 100);
}

function renderRegularEmployeeSelector() {
  const wrap = document.createElement('div');
  wrap.className = 'regular-employee-selector';

  const employees = ['all', ...(state.regular?.employees || [])];
  employees.forEach((employee) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isActive = employee === 'all' ? activeRegularEmployee === 'all' : sameEmployee(activeRegularEmployee, employee);
    btn.className = `employee-pill${isActive ? ' active' : ''}`;
    btn.textContent = employee === 'all' ? 'All employees' : employee;
    btn.addEventListener('click', () => {
      activeRegularEmployee = employee;
      render();
    });
    if (employee !== 'all') {
      btn.addEventListener('dblclick', () => {
        const newName = prompt('Rename employee', employee);
        if (newName && newName.trim() && newName.trim() !== employee) {
          renameRegularEmployee(employee, newName.trim());
        }
      });
    }
    wrap.appendChild(btn);
  });

  return wrap;
}

function getActiveRegularSectionTitle() {
  if (activeRegularEmployee && activeRegularEmployee !== 'all') {
    const emp = (state.employees || []).find(e => e.email === activeRegularEmployee);
    const displayName = emp && emp.name ? emp.name : activeRegularEmployee;
    return `${displayName}'s Regular Tasks`;
  }
  return 'Regular Tasks';
}

function renderRegularToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'regular-toolbar';

  const dates = getRegularDates();
  const visibleStart = dates[0] || regularStartDate;
  const visibleEnd = dates[dates.length - 1] || regularStartDate;
  const isFullMonthView = dates.length > 1
    && visibleStart.getDate() === 1
    && visibleEnd.getMonth() === visibleStart.getMonth()
    && visibleEnd.getFullYear() === visibleStart.getFullYear()
    && visibleEnd.getDate() === daysInMonth(visibleStart);

  const month = document.createElement('strong');
  if (isFullMonthView) {
    month.textContent = `${MONTHS[visibleStart.getMonth()]} ${visibleStart.getFullYear()}`;
  } else {
    const startLabel = `${visibleStart.getDate()} ${MONTHS[visibleStart.getMonth()]}`;
    const endLabel = `${visibleEnd.getDate()} ${MONTHS[visibleEnd.getMonth()]} ${visibleEnd.getFullYear()}`;
    month.textContent = `${startLabel} – ${endLabel}`;
  }
  toolbar.appendChild(month);

  const actions = document.createElement('div');
  actions.className = 'regular-date-actions';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'btn';
  prevBtn.textContent = 'Prev';
  prevBtn.addEventListener('click', () => {
    const targetStart = firstDayOfMonth(addMonths(visibleStart, -1));
    const count = daysInMonth(targetStart);
    regularStartDate = targetStart;
    state.regular.columns = Array.from({ length: count }, (_, index) => dateKey(addDays(regularStartDate, index)));
    persist();
    render();
  });
  actions.appendChild(prevBtn);

  const currentBtn = document.createElement('button');
  currentBtn.type = 'button';
  currentBtn.className = 'btn';
  currentBtn.textContent = 'Current';
  currentBtn.title = 'Show previous 15 days, today, and next 7 days';
  currentBtn.addEventListener('click', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = addDays(today, -15);
    const totalDays = 15 + 1 + 7;
    regularStartDate = start;
    state.regular.columns = Array.from({ length: totalDays }, (_, index) => dateKey(addDays(start, index)));
    persist();
    render();
  });
  actions.appendChild(currentBtn);

  const thisMonthBtn = document.createElement('button');
  thisMonthBtn.type = 'button';
  thisMonthBtn.className = 'btn';
  thisMonthBtn.textContent = 'This month';
  thisMonthBtn.addEventListener('click', () => {
    const targetStart = firstDayOfMonth(new Date());
    const count = daysInMonth(targetStart);
    regularStartDate = targetStart;
    state.regular.columns = Array.from({ length: count }, (_, index) => dateKey(addDays(regularStartDate, index)));
    persist();
    render();
  });
  actions.appendChild(thisMonthBtn);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn';
  nextBtn.textContent = 'Next';
  nextBtn.addEventListener('click', () => {
    const targetStart = firstDayOfMonth(addMonths(visibleStart, 1));
    const count = daysInMonth(targetStart);
    regularStartDate = targetStart;
    state.regular.columns = Array.from({ length: count }, (_, index) => dateKey(addDays(regularStartDate, index)));
    persist();
    render();
  });
  actions.appendChild(nextBtn);

  const addRowBtn = document.createElement('button');
  addRowBtn.type = 'button';
  addRowBtn.className = 'btn secondary';
  addRowBtn.textContent = '+ Row';
  addRowBtn.addEventListener('click', openAddRegularRowPopup);
  actions.appendChild(addRowBtn);

  const removeRowBtn = document.createElement('button');
  removeRowBtn.type = 'button';
  removeRowBtn.className = 'btn secondary danger';
  removeRowBtn.textContent = '- Row';
  removeRowBtn.addEventListener('click', openRemoveRegularRowPopup);
  actions.appendChild(removeRowBtn);

  const columnLabel = document.createElement('span');
  columnLabel.className = 'regular-column-count';
  columnLabel.textContent = `${dates.length} days`;
  actions.appendChild(columnLabel);

  toolbar.appendChild(actions);
  return toolbar;
}

function renderRegularGridView() {
  const panel = document.createElement('div');
  panel.className = 'regular-grid-panel';
  const dates = getRegularDates();
  const tasks = getRegularTasks();

  if (!tasks.length) {
    panel.appendChild(renderEmptyState('No regular tasks for this employee.'));
    return panel;
  }

  const table = document.createElement('table');
  table.className = 'regular-grid';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Employee', 'Task', 'Priority', 'Time', 'Status'].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  dates.forEach((date, index) => {
    const th = document.createElement('th');
    th.className = [isWeekend(date) ? 'weekend' : '', dateKey(date) === todayStr() ? 'today-col' : ''].filter(Boolean).join(' ');
    th.draggable = true;
    th.dataset.columnIndex = String(index);
    th.innerHTML = `<span>${date.getDate()}</span><small>${WEEKDAYS[date.getDay()].slice(0, 3).toUpperCase()}</small>`;
    th.title = `${date.getDate()} ${MONTHS[date.getMonth()]} (${WEEKDAYS[date.getDay()]})`;
    th.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', String(index));
      event.dataTransfer.effectAllowed = 'move';
    });
    th.addEventListener('dragover', (event) => event.preventDefault());
    th.addEventListener('drop', (event) => {
      event.preventDefault();
      const fromIndex = Number(event.dataTransfer.getData('text/plain'));
      const toIndex = Number(event.currentTarget.dataset.columnIndex);
      moveRegularColumn(fromIndex, toIndex);
    });
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  groupedRegularTasks(tasks).forEach(([group, subgroups]) => {
    const groupRow = document.createElement('tr');
    groupRow.className = 'regular-group-row';
    const groupCell = document.createElement('td');
    groupCell.colSpan = dates.length + 5;
    groupCell.textContent = group;
    groupRow.appendChild(groupCell);
    tbody.appendChild(groupRow);

    subgroups.forEach(({ category, tasks: rows }) => {
      if (category) {
        const subgroupRow = document.createElement('tr');
        subgroupRow.className = 'regular-subgroup-row';
        const subgroupCell = document.createElement('td');
        subgroupCell.colSpan = dates.length + 5;
        subgroupCell.textContent = category;
        subgroupRow.appendChild(subgroupCell);
        tbody.appendChild(subgroupRow);
      }

      rows.forEach((task) => {
        const tr = document.createElement('tr');
        tr.draggable = true;
        tr.dataset.taskId = task.id;
        tr.addEventListener('dragstart', (event) => {
          event.dataTransfer.setData('text/plain', task.id);
          event.dataTransfer.effectAllowed = 'move';
        });
        tr.addEventListener('dragover', (event) => event.preventDefault());
        tr.addEventListener('drop', (event) => {
          event.preventDefault();
          const fromId = event.dataTransfer.getData('text/plain');
          if (fromId && fromId !== task.id) moveRegularRow(fromId, task.id);
        });

        const ownerCell = document.createElement('td');
        ownerCell.appendChild(editableText(task.owner, (value) => updateRegularTask(task, 'owner', value), 'regular-editable'));
        tr.appendChild(ownerCell);

        const titleCell = document.createElement('td');
        titleCell.appendChild(editableText(task.title, (value) => updateRegularTask(task, 'title', value), 'regular-editable'));
        tr.appendChild(titleCell);

        tr.appendChild(renderRegularPriorityCell(task));

        const timeCell = document.createElement('td');
        timeCell.appendChild(editableText(regularScheduleValue(task), (value) => updateRegularSchedule(task, value), 'regular-editable', regularSchedulePlaceholder(task.cadence)));
        tr.appendChild(timeCell);

        tr.appendChild(textCell(`${regularTaskProgress(task, dates).pct}%`));

        dates.forEach((date) => {
          const td = document.createElement('td');
          td.className = [isWeekend(date) ? 'weekend' : '', dateKey(date) === todayStr() ? 'today-col' : ''].filter(Boolean).join(' ');
          if (isRegularTaskExpected(task, date)) {
            td.appendChild(renderRegularCheckbox(task, date));
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    });
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  return panel;
}

// Month calendar for Regular Tasks. Daily tasks are deliberately excluded --
// they'd otherwise fill in every single cell and drown out the tasks that
// actually only happen on specific days (weekly/monthly/quarterly/...).
function renderRegularCalendarView() {
  const wrap = document.createElement('div');
  wrap.className = 'calendar-view-panel regular-calendar-panel';

  wrap.appendChild(renderCalendarToolbar(regularCalendarMonth, (next) => {
    regularCalendarMonth = next;
    render();
  }));

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  const weekdayRow = document.createElement('div');
  weekdayRow.className = 'calendar-weekdays';
  WEEKDAYS.forEach((w) => {
    const cell = document.createElement('div');
    cell.textContent = w;
    weekdayRow.appendChild(cell);
  });
  grid.appendChild(weekdayRow);

  const days = document.createElement('div');
  days.className = 'calendar-days';

  const month = regularCalendarMonth;
  const startOfGrid = addDays(month, -month.getDay());
  const today = todayStr();
  const tasks = getRegularTasks().filter((task) => task.cadence !== 'daily');
  const maxPerDay = 4;

  for (let i = 0; i < 42; i++) {
    const date = addDays(startOfGrid, i);
    const key = dateKey(date);
    const inMonth = date.getMonth() === month.getMonth();

    const cell = document.createElement('div');
    cell.className = `calendar-cell${inMonth ? '' : ' outside'}${key === today ? ' today' : ''}`;

    const dayNum = document.createElement('div');
    dayNum.className = 'calendar-day-num';
    dayNum.textContent = date.getDate();
    cell.appendChild(dayNum);

    // Outside-month cells (the adjacent month's overflow days shown to fill
    // the grid) intentionally show no tasks here -- a monthly/quarterly/etc.
    // task can land on, say, "Sep 5" while it's rendered as a trailing cell
    // inside August's view, and toggling it would tick a date nowhere
    // visible in the currently-open month's Grid view, looking exactly like
    // a broken sync. Only the true "this month" cells are interactive.
    if (inMonth) {
      const dayTasks = tasks.filter((task) => isRegularTaskExpected(task, date));
      const locked = isPastDate(date);

      dayTasks.slice(0, maxPerDay).forEach((task) => {
        const done = isRegularDone(task, date);
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `calendar-pill regular-calendar-pill${done ? ' done' : ''}`;
        pill.textContent = task.title;
        pill.title = `${task.title} — ${task.owner}${locked ? ' (past date, locked)' : ''}`;
        pill.disabled = locked;
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          if (locked) return;
          toggleRegularCompletion(task, date);
        });
        cell.appendChild(pill);
      });

      if (dayTasks.length > maxPerDay) {
        const more = document.createElement('div');
        more.className = 'calendar-more';
        more.textContent = `+${dayTasks.length - maxPerDay} more`;
        cell.appendChild(more);
      }
    }

    days.appendChild(cell);
  }

  grid.appendChild(days);
  wrap.appendChild(grid);
  return wrap;
}

function renderRegularTableView() {
  const panel = document.createElement('div');
  panel.className = 'table-panel';
  const dates = getRegularDates();
  const tasks = getRegularTasks();
  const table = document.createElement('table');
  table.className = 'task-table regular-summary-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['Employee', 'Task', 'Schedule', 'Completed', 'Status'].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  tasks.forEach((task) => {
    const progress = regularTaskProgress(task, dates);
    const tr = document.createElement('tr');
    tr.draggable = true;
    tr.dataset.taskId = task.id;
    tr.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', task.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    tr.addEventListener('dragover', (event) => event.preventDefault());
    tr.addEventListener('drop', (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer.getData('text/plain');
      if (fromId && fromId !== task.id) moveRegularRow(fromId, task.id);
    });

    const ownerTd = document.createElement('td');
    ownerTd.appendChild(editableText(task.owner, (value) => updateRegularTask(task, 'owner', value), 'regular-editable'));
    tr.appendChild(ownerTd);

    const titleTd = document.createElement('td');
    titleTd.appendChild(editableText(task.title, (value) => updateRegularTask(task, 'title', value), 'regular-editable'));
    tr.appendChild(titleTd);

    const scheduleTd = document.createElement('td');
    scheduleTd.appendChild(editableText(regularScheduleValue(task), (value) => updateRegularSchedule(task, value), 'regular-editable', regularSchedulePlaceholder(task.cadence)));
    tr.appendChild(scheduleTd);

    tr.appendChild(textCell(`${progress.done}/${progress.total}`));
    tr.appendChild(textCell(`${progress.pct}%`));


    tbody.appendChild(tr);
  });
  panel.appendChild(tasks.length ? table : renderEmptyState('No regular tasks for this employee.'));
  return panel;
}

function renderRegularStackView() {
  const panel = document.createElement('div');
  panel.className = 'stack-panel regular-stack';
  const dates = getRegularDates();
  const tasks = getRegularTasks();
  if (!tasks.length) {
    panel.appendChild(renderEmptyState('No regular tasks for this employee.'));
    return panel;
  }
  tasks.forEach((task, index) => {
    const progress = regularTaskProgress(task, dates);
    const card = document.createElement('article');
    card.className = `stack-item regular-card cadence-${task.cadence}`;
    card.draggable = true;
    card.dataset.taskId = task.id;
    card.style.animationDelay = `${Math.min(index * 35, 420)}ms`;
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', task.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragover', (event) => event.preventDefault());
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer.getData('text/plain');
      if (fromId && fromId !== task.id) moveRegularRow(fromId, task.id);
    });
    const title = document.createElement('div');
    title.className = 'stack-title';
    title.appendChild(editableText(task.title, (value) => updateRegularTask(task, 'title', value), 'regular-editable title-edit'));
    card.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'stack-meta';
    const cadenceChip = document.createElement('span');
    cadenceChip.appendChild(editableText(task.cadence, (value) => updateRegularTask(task, 'cadence', value), 'regular-editable'));
    meta.appendChild(cadenceChip);
    const ownerChip = document.createElement('span');
    ownerChip.appendChild(editableText(task.owner, (value) => updateRegularTask(task, 'owner', value), 'regular-editable owner-edit'));
    meta.appendChild(ownerChip);
    const timeChip = document.createElement('span');
    timeChip.appendChild(editableText(regularScheduleValue(task), (value) => updateRegularSchedule(task, value), 'regular-editable', regularSchedulePlaceholder(task.cadence)));
    meta.appendChild(timeChip);
    const groupChip = document.createElement('span');
    groupChip.appendChild(editableText(task.group || '', (value) => updateRegularTask(task, 'group', value), 'regular-editable'));
    meta.appendChild(groupChip);
    const progressChip = document.createElement('span');
    progressChip.textContent = `${progress.pct}% done`;
    meta.appendChild(progressChip);
    const actionChip = document.createElement('span');
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn small danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteRegularTask(task.id));
    actionChip.appendChild(deleteBtn);
    meta.appendChild(actionChip);
    card.appendChild(meta);
    const checks = document.createElement('div');
    checks.className = 'regular-card-checks';
    dates.filter((date) => isRegularTaskExpected(task, date)).slice(0, 8).forEach((date) => {
      const wrap = document.createElement('label');
      wrap.title = dateKey(date);
      wrap.appendChild(renderRegularCheckbox(task, date));
      const text = document.createElement('span');
      text.textContent = `${date.getDate()} ${WEEKDAYS[date.getDay()]}`;
      wrap.appendChild(text);
      checks.appendChild(wrap);
    });
    card.appendChild(checks);
    panel.appendChild(card);
  });
  return panel;
}

function renderRegularCheckbox(task, date) {
  const checked = isRegularDone(task, date);
  const locked = isPastDate(date);
  const wrapper = document.createElement('label');
  wrapper.className = `regular-checkbox-wrap${locked ? ' locked' : ''}`;
  wrapper.title = locked
    ? `${task.title} - ${dateKey(date)} (locked: past date)`
    : `${task.title} - ${dateKey(date)}`;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = locked;
  input.className = 'regular-checkbox';
  input.addEventListener('change', (event) => {
    event.stopPropagation();
    if (locked) return;
    toggleRegularCompletion(task, date);
  });

  const span = document.createElement('span');
  span.className = `regular-check${checked ? ' checked' : ''}${locked ? ' locked' : ''}`;

  wrapper.appendChild(input);
  wrapper.appendChild(span);
  return wrapper;
}

// Two-level grouping: cadence is always the top-level section (Daily,
// Weekly, ...); category (if set) nests as a sub-section INSIDE that
// cadence block rather than forming its own parallel top-level section.
// Returns [[cadenceLabel, [{category, tasks}, ...]], ...] -- the first
// subgroup per cadence (category: '') holds the uncategorized tasks and
// renders with no sub-header.
function groupedRegularTasks(tasks) {
  const order = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Half-yearly', 'Yearly'];
  const cadenceMap = new Map();
  tasks.forEach((task) => {
    const cadence = cadenceLabel(task.cadence);
    if (!cadenceMap.has(cadence)) cadenceMap.set(cadence, new Map());
    const subMap = cadenceMap.get(cadence);
    const category = task.category || '';
    if (!subMap.has(category)) subMap.set(category, []);
    subMap.get(category).push(task);
  });
  const cadenceEntries = [...cadenceMap.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return cadenceEntries.map(([cadence, subMap]) => {
    const subgroups = [...subMap.entries()]
      .sort((a, b) => {
        if (a[0] === '') return -1;
        if (b[0] === '') return 1;
        return a[0].localeCompare(b[0]);
      })
      .map(([category, rows]) => ({ category, tasks: rows }));
    return [cadence, subgroups];
  });
}

// Quarterly/half-yearly tasks recur on the same day-of-month every 3 or 6
// months starting from task.month -- but showing that fixed starting month
// forever (e.g. always "Jan 15") reads as if the schedule is stuck/wrong
// once it's, say, October. Show whichever qualifying month is coming up
// next (or today, if today is one) instead, so the label actually reflects
// where the task is in its own cycle.
// The date of the Nth (1st-5th) occurrence of a weekday within a given
// month -- may land in the following month if that occurrence doesn't
// exist (e.g. a "5th Friday" in a month that only has 4), same tolerance
// matchesWeekdayPattern already has when checking the grid.
function nthWeekdayOfMonth(year, month, weekday, ordinal) {
  const first = new Date(year, month, 1);
  const offset = ((weekday - first.getDay()) + 7) % 7;
  const day = 1 + offset + (Math.min(5, ordinal || 1) - 1) * 7;
  return new Date(year, month, day);
}

function nextRegularOccurrence(task) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const refMonth = Number.isInteger(task.month) ? task.month : 0;
  const interval = task.cadence === 'half-yearly' ? 6 : 3;
  const weekdayMode = task.monthlyMode === 'weekday';
  const occurrenceInMonth = (year, month) => weekdayMode
    ? nthWeekdayOfMonth(year, month, task.weekday || 0, task.weekdayOrdinal)
    : new Date(year, month, task.dayOfMonth || 1);

  let month = refMonth;
  let candidate = occurrenceInMonth(today.getFullYear(), month);
  while (candidate < today) {
    month += interval;
    candidate = occurrenceInMonth(today.getFullYear(), month);
  }
  return candidate;
}

function regularScheduleLabel(task) {
  if (task.cadence === 'daily') return task.time || 'Daily';
  if (task.cadence === 'weekly') return WEEKDAYS[task.weekday] || 'Weekly';
  if (task.cadence === 'yearly') {
    if (task.monthlyMode === 'weekday') {
      const ordinalWord = ORDINAL_WORDS[Math.min(5, task.weekdayOrdinal || 1) - 1];
      return `${MONTHS[task.month || 0]} ${ordinalWord} ${WEEKDAYS[task.weekday]}`;
    }
    return `${MONTHS[task.month || 0]} ${task.dayOfMonth}`;
  }
  if (task.cadence === 'quarterly' || task.cadence === 'half-yearly') {
    const next = nextRegularOccurrence(task);
    if (task.monthlyMode === 'weekday') {
      const ordinalWord = ORDINAL_WORDS[Math.min(5, task.weekdayOrdinal || 1) - 1];
      return `${MONTHS[next.getMonth()]} ${ordinalWord} ${WEEKDAYS[next.getDay()]}`;
    }
    return `${MONTHS[next.getMonth()]} ${next.getDate()}`;
  }
  if (task.monthlyMode === 'weekday') {
    const ordinalWord = ORDINAL_WORDS[Math.min(5, task.weekdayOrdinal || 1) - 1];
    return `${ordinalWord} ${WEEKDAYS[task.weekday]}`;
  }
  return `Day ${task.dayOfMonth}`;
}

function renderViewTabs() {
  const viewMenu = document.querySelector('.view-menu');
  if (activeWorkspace === 'regular' || activeWorkspace === 'charts' || activeWorkspace === 'kra' || activeWorkspace === 'productivity') {
    if (viewMenu) viewMenu.style.display = 'none';
    return;
  }
  if (viewMenu) viewMenu.style.display = '';

  const meta = VIEW_META[viewMode] || VIEW_META.board;
  const btn = document.querySelector('.view-menu-btn');
  if (btn) {
    btn.innerHTML = `${meta.icon}<span class="view-menu-label">${meta.label}</span>`;
    btn.title = `Change view (currently ${meta.label})`;
  }

  document.querySelectorAll('.view-option').forEach((opt) => {
    const active = opt.dataset.view === viewMode;
    opt.classList.toggle('active', active);
    opt.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function renderList(list, options = {}) {
  const node = tplList.content.firstElementChild.cloneNode(true);
  node.dataset.listId = list.id;
  node.style.setProperty('--list-accent', listAccentColor(list.id));
  makeResizable(node, `list:${list.id}`);

  const nameEl = node.querySelector('.list-name');
  nameEl.textContent = list.name;
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = list.name; nameEl.blur(); }
  });
  nameEl.addEventListener('blur', () => {
    const val = nameEl.textContent.trim() || list.name;
    nameEl.textContent = val;
    if (val !== list.name) { list.name = val; persist(); }
  });

  const visibleTasks = filterTasks(list.tasks);

  const countEl = node.querySelector('.list-count');
  const openCount = visibleTasks.filter((t) => !t.done).length;
  countEl.textContent = openCount || '';

  // Attendance time badge + mood button (one per list) shown beside the
  // menu — only on the main task-board lists, not project cards.
  if (options.container !== 'projects') {
    const quickAddBtn = document.createElement('button');
    quickAddBtn.type = 'button';
    quickAddBtn.className = 'list-quick-add-btn';
    quickAddBtn.textContent = '+';
    quickAddBtn.title = `Add task for ${list.name}`;
    quickAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openItemPopup(null, false, list.name);
    });
    nameEl.after(quickAddBtn);

    const attendanceBtn = renderListAttendanceButton(list);
    if (attendanceBtn) nameEl.after(attendanceBtn);

    nameEl.after(renderListCopyStatusIcon(list));

    const moodBtn = document.createElement('button');
    moodBtn.type = 'button';
    moodBtn.className = 'list-mood-btn';
    const moodEmojis = { happy: '🤩', neutral: '😐', sad: '🥱', busy: '😎' };
    const listMood = list.mood || 'neutral';
    moodBtn.textContent = moodEmojis[listMood] || '😐';
    moodBtn.title = 'Click to change employee mood';
    moodBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cycleListMood(list);
    });
    const menuWrap = node.querySelector('.list-menu-wrap');
    menuWrap.parentNode.insertBefore(moodBtn, menuWrap);
  }

  // menu
  const menuBtn = node.querySelector('.list-menu-btn');
  const menu = node.querySelector('.list-menu');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.list-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
    menu.classList.toggle('hidden');
  });
  const container = options.container === 'projects' ? state.projects : state.lists;
  const isProject = options.container === 'projects';

  const archiveListBtn = menu.querySelector('[data-action="archive-list"]');
  archiveListBtn.textContent = isProject ? 'Archive project' : 'Archive list';
  archiveListBtn.addEventListener('click', () => {
    list.archived = true;
    list.archivedAt = Date.now();
    if (!isProject && activeListId === list.id) activeListId = 'all';
    persist();
    render();
    showToast(`Archived ${isProject ? 'project' : 'list'} "${list.name}" — find it under Archived to restore`, () => {
      list.archived = false;
      list.archivedAt = null;
      persist();
      render();
    });
    menu.classList.add('hidden');
  });

  const deleteListBtn = menu.querySelector('[data-action="delete-list"]');
  deleteListBtn.textContent = isProject ? 'Delete project' : 'Delete list';
  deleteListBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (deleteListBtn.dataset.armed === '1') {
      const idx = container.findIndex((l) => l.id === list.id);
      if (idx === -1) return;
      const removed = container.splice(idx, 1)[0];
      if (!isProject && activeListId === removed.id) activeListId = 'all';
      persist();
      render();
      showToast(`Deleted ${isProject ? 'project' : 'list'} "${removed.name}"`, () => {
        container.splice(idx, 0, removed);
        if (!isProject) activeListId = removed.id;
        persist();
        render();
      });
      menu.classList.add('hidden');
    } else {
      deleteListBtn.dataset.armed = '1';
      deleteListBtn.textContent = 'Click again to confirm';
      setTimeout(() => {
        deleteListBtn.dataset.armed = '0';
        deleteListBtn.textContent = isProject ? 'Delete project' : 'Delete list';
      }, 3000);
    }
  });

  const editListBtn = menu.querySelector('[data-action="edit-list"]');
  if (editListBtn) {
    if (isProject) {
      editListBtn.addEventListener('click', () => {
        openItemPopup(list, true);
        menu.classList.add('hidden');
      });
    } else {
      // Editing a plain task list only ever exposed name/description/sections,
      // which wasn't useful enough to keep — removed from the "All tasks" menu.
      editListBtn.remove();
    }
  }

  // Copy moved out of this menu onto its own always-visible icon in the
  // header (see renderListCopyStatusIcon) -- see that function for why.

  // sections
  const sectionsWrap = node.querySelector('.sections');
  (list.sections || []).forEach((section) => {
    sectionsWrap.appendChild(renderSection(list, section));
  });

  // unsectioned tasks
  const unsectioned = node.querySelector('.unsectioned');
  unsectioned.dataset.scrollKey = `${list.id}:unsectioned`;
  // Same "Done" quick-filter exception as renderSection() above -- see
  // that comment.
  const showDoneInMain = activeQuickStatus === 'done';
  const topTasks = visibleTasks.filter((t) => (showDoneInMain ? t.done : !t.done) && !t.sectionId);
  topTasks.forEach((task) => unsectioned.appendChild(renderTask(list, task)));

  // completed — shown as a small icon+count in the header (rather than a
  // full-width toggle row) that only appears once there's something to
  // show, and expands the panel below in place when clicked. Suppressed
  // while the "Done" filter has already put completed tasks front and
  // center above, so they aren't shown twice.
  const completed = showDoneInMain ? [] : visibleTasks.filter((t) => t.done);
  const completedWrap = node.querySelector('.completed-wrap');
  const completedList = node.querySelector('.completed-list');
  completedList.dataset.scrollKey = `${list.id}:completed`;
  completed
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .forEach((task) => completedList.appendChild(renderTask(list, task)));

  const completedBtn = node.querySelector('.list-completed-btn');
  node.querySelector('.list-completed-count').textContent = completed.length;
  completedBtn.classList.toggle('hidden', completed.length === 0);
  completedBtn.title = `${completed.length} completed`;
  completedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    completedWrap.classList.toggle('hidden');
    completedBtn.classList.toggle('active', !completedWrap.classList.contains('hidden'));
  });

  // deleted
  const deletedTasks = list.deletedTasks || [];
  const deletedWrap = node.querySelector('.deleted-wrap');
  const deletedList = node.querySelector('.deleted-list');
  deletedTasks.forEach((entry) => deletedList.appendChild(renderDeletedTaskRow(list, entry)));

  const deletedBtn = node.querySelector('.list-deleted-btn');
  node.querySelector('.list-deleted-count').textContent = deletedTasks.length;
  deletedBtn.classList.toggle('hidden', deletedTasks.length === 0);
  deletedBtn.title = `${deletedTasks.length} deleted`;
  deletedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deletedWrap.classList.toggle('hidden');
    deletedBtn.classList.toggle('active', !deletedWrap.classList.contains('hidden'));
  });

  return node;
}

function renderDeletedTaskRow(list, entry) {
  const row = document.createElement('div');
  row.className = 'deleted-task-row';

  const text = document.createElement('span');
  text.className = 'deleted-task-text';
  text.textContent = entry.task.text;
  row.appendChild(text);

  const meta = document.createElement('span');
  meta.className = 'deleted-task-meta';
  meta.textContent = fmtShort(entry.deletedAt);
  row.appendChild(meta);

  const actions = document.createElement('span');
  actions.className = 'deleted-task-actions';

  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'deleted-task-restore';
  restoreBtn.textContent = 'Restore';
  restoreBtn.addEventListener('click', () => restoreDeletedTask(list, entry.id));
  actions.appendChild(restoreBtn);

  const forgetBtn = document.createElement('button');
  forgetBtn.type = 'button';
  forgetBtn.className = 'deleted-task-forget';
  forgetBtn.title = 'Remove permanently';
  forgetBtn.innerHTML = '&times;';
  forgetBtn.addEventListener('click', () => {
    if (confirm(`Permanently remove "${entry.task.text}"? This can't be undone.`)) {
      permanentlyDeleteTask(list, entry.id);
    }
  });
  actions.appendChild(forgetBtn);

  row.appendChild(actions);

  const reasonPicker = renderDeleteReasonPicker(itemDisplayProgress(entry.task), entry.reason, (value) => {
    entry.reason = value;
    persist();
    render();
  });
  if (reasonPicker) row.appendChild(reasonPicker);

  return row;
}

function renderSection(list, section) {
  const node = tplSection.content.firstElementChild.cloneNode(true);
  node.dataset.sectionId = section.id;
  if (section.collapsed) node.classList.add('collapsed');

  const nameEl = node.querySelector('.section-name');
  nameEl.textContent = section.name;
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = section.name; nameEl.blur(); }
  });
  nameEl.addEventListener('blur', () => {
    const val = nameEl.textContent.trim() || section.name;
    nameEl.textContent = val;
    if (val !== section.name) { section.name = val; persist(); }
  });

  const collapseBtn = node.querySelector('.section-collapse');
  const tasksWrap = node.querySelector('.section-tasks');
  tasksWrap.dataset.scrollKey = `${list.id}:section:${section.id}`;
  if (section.collapsed) tasksWrap.classList.add('collapsed');
  collapseBtn.textContent = section.collapsed ? '>' : 'v';
  collapseBtn.addEventListener('click', () => {
    section.collapsed = !section.collapsed;
    persist();
    render();
  });

  node.querySelector('.section-delete').addEventListener('click', () => {
    const hasTasks = list.tasks.some((t) => t.sectionId === section.id && !t.done);
    if (hasTasks && !confirm(`Delete section "${section.name}"? Its open tasks will move to the top of the list.`)) return;
    list.tasks.forEach((t) => { if (t.sectionId === section.id) t.sectionId = null; });
    list.sections = list.sections.filter((s) => s.id !== section.id);
    persist();
    render();
  });

  // The "Done" quick-filter (top stat bar) narrows filterTasks() to
  // completed tasks only -- normally this section only ever shows open
  // work (done tasks live in the collapsed Completed panel instead), but
  // while that filter is active, completed tasks need to actually show up
  // here or clicking "Done" visibly does nothing.
  const sectionTasks = filterTasks(list.tasks)
    .filter((t) => (activeQuickStatus === 'done' ? t.done : !t.done) && t.sectionId === section.id);
  sectionTasks.forEach((task) => tasksWrap.appendChild(renderTask(list, task)));

  return node;
}

function renderTask(list, task) {
  const node = tplTask.content.firstElementChild.cloneNode(true);
  node.dataset.taskId = task.id;
  if (task.done) node.classList.add('done');

  const checkBtn = node.querySelector('.task-check');
  checkBtn.title = task.done ? 'Restore task (undo)' : 'Mark done';
  checkBtn.addEventListener('click', () => toggleDone(list, task));

  const progress = itemDisplayProgress(task);
  const barEl = node.querySelector('.task-progress-bar');
  attachFluidProgressDrag(barEl, progress, (val) => {
    setTaskProgress(list, task, val);
  });

  const priorityEl = node.querySelector('.task-priority');
  priorityEl.classList.add(task.priority || 'none');
  priorityEl.textContent = task.priority === 'high' ? 'High' : task.priority === 'medium' ? 'Med' : task.priority === 'low' ? 'Low' : '';
  priorityEl.title = 'Click to cycle priority';
  priorityEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = PRIORITY_ORDER.indexOf(task.priority || 'none');
    task.priority = PRIORITY_ORDER[(idx + 1) % PRIORITY_ORDER.length];
    persist();
    render();
  });

  const textEl = node.querySelector('.task-text');
  textEl.textContent = task.text;
  textEl.contentEditable = !task.done;
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); textEl.textContent = task.text; textEl.blur(); }
  });
  textEl.addEventListener('blur', () => {
    const val = textEl.textContent.trim();
    if (!val) { textEl.textContent = task.text; return; }
    if (val !== task.text) { task.text = val; persist(); }
  });

  // Assigned user display removed — assignment is tracked but not shown on task row

  const copyBtn = node.querySelector('.task-copy');
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyTextToClipboard(buildSingleItemShareText(task, false))
      .then(() => showToast('Copied — paste it in WhatsApp or anywhere'))
      .catch(() => showToast('Could not copy to clipboard'));
  });

  const duplicateBtn = node.querySelector('.task-duplicate');
  duplicateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openItemPopup(task, false, '', '', true);
  });

  if (task.description) {
    const descEl = document.createElement('div');
    descEl.className = 'task-description';
    descEl.textContent = task.description;
    node.querySelector('.task-body').insertBefore(descEl, node.querySelector('.task-meta'));
  }

  const deleteBtn = node.querySelector('.task-delete');
  deleteBtn.addEventListener('click', () => deleteTask(list, task));

  const dueEl = node.querySelector('.task-due');
  const { text: dueText, cls: dueCls } = dueLabel(task.due, task);
  dueEl.textContent = dueText;
  dueEl.className = `task-due ${dueCls}`;
  dueEl.addEventListener('click', () => openDatePicker(list, task, dueEl));

  const createdEl = node.querySelector('.task-created');
  createdEl.textContent = task.done && task.completedAt ? formatCompletedDate(task.completedAt) : '';

  if (task.startDate) {
    const startDateEl = document.createElement('span');
    startDateEl.className = 'task-start-date';
    startDateEl.textContent = `Start ${fmtShort(new Date(`${task.startDate}T00:00:00`).getTime())}`;
    node.querySelector('.task-meta').insertBefore(startDateEl, createdEl.nextSibling);
  }

  const statusEl = node.querySelector('.task-status');
  statusEl.className = `task-status ${statusSlug(task.status)}`;
  statusEl.textContent = normalizeStatusValue(task.status);
  statusEl.title = 'Click to change status';
  statusEl.addEventListener('click', (e) => {
    e.stopPropagation();
    task.status = nextStatus(task.status);
    persist();
    render();
  });

  node.querySelector('.task-meta').appendChild(renderCategoryChip(task, (value) => {
    task.category = value;
    persist();
    render();
  }));

  const editBtn = node.querySelector('.task-edit');
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openItemPopup(task, false);
  });

  return node;
}

function renderTableView() {
  const wrap = document.createElement('div');
  wrap.className = 'table-panel';

  const rows = getAllTaskRows(true).sort((a, b) => {
    if (a.task.done !== b.task.done) return a.task.done ? 1 : -1;
    if ((a.task.due || '') !== (b.task.due || '')) return (a.task.due || '9999') > (b.task.due || '9999') ? 1 : -1;
    return b.task.createdAt - a.task.createdAt;
  });

  if (!rows.length) {
    wrap.appendChild(renderEmptyState('No tasks here yet. Add one from the horizontal board view.'));
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'task-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Done</th>
        <th>Task</th>
        <th>List</th>
        <th>Section</th>
        <th>Priority</th>
        <th>Start Date</th>
        <th>Status</th>
        <th>Due</th>
        <th></th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  rows.forEach(({ list, task, sectionName }) => {
    const tr = document.createElement('tr');
    if (task.done) tr.classList.add('done');

    const status = document.createElement('td');
    const check = document.createElement('button');
    check.className = 'task-check table-check';
    check.title = task.done ? 'Restore task' : 'Mark done';
    check.addEventListener('click', () => toggleDone(list, task));
    status.appendChild(check);
    tr.appendChild(status);

    const title = document.createElement('td');
    const text = document.createElement('span');
    text.className = 'table-task-text';
    text.textContent = task.text;
    text.contentEditable = !task.done;
    text.spellcheck = false;
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); text.textContent = task.text; text.blur(); }
    });
    text.addEventListener('blur', () => {
      const val = text.textContent.trim();
      if (!val) { text.textContent = task.text; return; }
      if (val !== task.text) { task.text = val; persist(); render(); }
    });
    title.appendChild(text);
    tr.appendChild(title);

    tr.appendChild(textCell(list.name));
    tr.appendChild(textCell(sectionName));

    const priority = document.createElement('td');
    const priorityBtn = document.createElement('button');
    priorityBtn.className = `priority-pill ${task.priority || 'none'}`;
    priorityBtn.textContent = task.priority && task.priority !== 'none' ? task.priority : 'none';
    priorityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = PRIORITY_ORDER.indexOf(task.priority || 'none');
      task.priority = PRIORITY_ORDER[(idx + 1) % PRIORITY_ORDER.length];
      persist();
      render();
    });
    priority.appendChild(priorityBtn);
    tr.appendChild(priority);

    // (Assigned To removed from table view by request)

    // Start Date column
    const startDateCell = document.createElement('td');
    startDateCell.textContent = task.startDate || '-';
    tr.appendChild(startDateCell);

    const statusTagCell = document.createElement('td');
    const statusTag = document.createElement('span');
    statusTag.className = `task-status ${statusSlug(task.status)}`;
    statusTag.textContent = normalizeStatusValue(task.status);
    statusTag.title = 'Click to change status';
    statusTag.addEventListener('click', (e) => {
      e.stopPropagation();
      task.status = nextStatus(task.status);
      persist();
      render();
    });
    statusTagCell.appendChild(statusTag);
    tr.appendChild(statusTagCell);

    const due = document.createElement('td');
    const dueBtn = document.createElement('button');
    const { text: dueText, cls: dueCls } = dueLabel(task.due, task);
    dueBtn.className = `due-pill ${dueCls}`;
    dueBtn.textContent = dueText || '+ due date';
    dueBtn.addEventListener('click', () => openDatePicker(list, task, dueBtn));
    due.appendChild(dueBtn);
    tr.appendChild(due);

    const actions = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn table-edit';
    editBtn.title = 'Edit task';
    editBtn.innerHTML = '&#9998;';
    editBtn.addEventListener('click', () => openItemPopup(task, false));
    actions.appendChild(editBtn);
    const del = document.createElement('button');
    del.className = 'icon-btn table-delete';
    del.title = 'Delete task';
    del.textContent = 'x';
    del.addEventListener('click', () => deleteTask(list, task));
    actions.appendChild(del);
    tr.appendChild(actions);

    tbody.appendChild(tr);
  });

  wrap.appendChild(table);
  return wrap;
}

function renderStackView() {
  const wrap = document.createElement('div');
  wrap.className = 'stack-panel';

  const rows = getAllTaskRows(false).sort((a, b) => {
    const priorityDelta = PRIORITY_ORDER.indexOf(b.task.priority || 'none') - PRIORITY_ORDER.indexOf(a.task.priority || 'none');
    if (priorityDelta) return priorityDelta;
    return (a.task.due || '9999') > (b.task.due || '9999') ? 1 : -1;
  });

  if (!rows.length) {
    wrap.appendChild(renderEmptyState('Everything is complete. Nice clean dashboard.'));
    return wrap;
  }

  rows.forEach(({ list, task, sectionName }, index) => {
    const item = document.createElement('article');
    item.className = `stack-item priority-${task.priority || 'none'}`;
    item.style.animationDelay = `${Math.min(index * 35, 420)}ms`;

    const check = document.createElement('button');
    check.className = 'task-check';
    check.title = 'Mark done';
    check.addEventListener('click', () => toggleDone(list, task));
    item.appendChild(check);

    const body = document.createElement('div');
    body.className = 'stack-body';

    const title = document.createElement('div');
    title.className = 'stack-title';
    title.textContent = task.text;
    body.appendChild(title);

    // Assigned user display removed — assignment is tracked but not shown here

    const meta = document.createElement('div');
    meta.className = 'stack-meta';
    const listChip = document.createElement('span');
    listChip.textContent = list.name;
    meta.appendChild(listChip);
    const sectionChip = document.createElement('span');
    sectionChip.textContent = sectionName;
    meta.appendChild(sectionChip);

    const statusTag = document.createElement('span');
    statusTag.className = `task-status ${statusSlug(task.status)}`;
    statusTag.textContent = normalizeStatusValue(task.status);
    statusTag.title = 'Click to change status';
    statusTag.addEventListener('click', (e) => {
      e.stopPropagation();
      task.status = nextStatus(task.status);
      persist();
      render();
    });
    meta.appendChild(statusTag);

    const { text: dueText, cls: dueCls } = dueLabel(task.due, task);
    const due = document.createElement('button');
    due.className = `due-pill ${dueCls}`;
    due.textContent = dueText || '+ due date';
    due.addEventListener('click', () => openDatePicker(list, task, due));
    meta.appendChild(due);
    body.appendChild(meta);

    item.appendChild(body);

    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn stack-edit';
    editBtn.title = 'Edit task';
    editBtn.innerHTML = '&#9998;';
    editBtn.addEventListener('click', () => openItemPopup(task, false));
    item.appendChild(editBtn);

    wrap.appendChild(item);
  });

  return wrap;
}

// Tasks/projects with a due date, scoped to the given lists — shared by the
// full Calendar view and the per-employee mini calendar. Projects live in
// state.projects (not on a list), so they're matched by owner name instead.
function getCalendarItems(lists) {
  const items = [];
  lists.forEach((list) => {
    filterTasks(list.tasks).forEach((task) => {
      if (task.due) items.push({ kind: 'task', list, task });
    });
  });
  if (activeListId === 'all') {
    (state.projects || []).forEach((project) => {
      if (!project.archived && project.dueDate) items.push({ kind: 'project', project });
    });
  } else {
    const seen = new Set();
    lists.forEach((list) => {
      getProjectsForPerson(list.name).forEach((project) => {
        if (project.dueDate && !seen.has(project.id)) {
          seen.add(project.id);
          items.push({ kind: 'project', project });
        }
      });
    });
  }
  return items;
}

function groupCalendarItemsByDate(items) {
  const map = new Map();
  items.forEach((item) => {
    const due = item.kind === 'task' ? item.task.due : item.project.dueDate;
    if (!due) return;
    if (!map.has(due)) map.set(due, []);
    map.get(due).push(item);
  });
  return map;
}

function renderCalendarToolbar(month, onChange) {
  const bar = document.createElement('div');
  bar.className = 'calendar-toolbar';

  const label = document.createElement('div');
  label.className = 'calendar-month-label';
  label.textContent = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;
  bar.appendChild(label);

  const nav = document.createElement('div');
  nav.className = 'calendar-nav';
  const mkNavBtn = (text, title, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn calendar-nav-btn';
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  };
  nav.appendChild(mkNavBtn('‹', 'Previous month', () => onChange(addMonths(month, -1))));
  nav.appendChild(mkNavBtn('Today', 'Jump to current month', () => onChange(firstDayOfMonth(new Date()))));
  nav.appendChild(mkNavBtn('›', 'Next month', () => onChange(addMonths(month, 1))));
  bar.appendChild(nav);

  return bar;
}

function renderCalendarGrid(month, itemsByDate, { maxPerDay = 3, onAddDay } = {}) {
  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  const weekdayRow = document.createElement('div');
  weekdayRow.className = 'calendar-weekdays';
  WEEKDAYS.forEach((w) => {
    const cell = document.createElement('div');
    cell.textContent = w;
    weekdayRow.appendChild(cell);
  });
  grid.appendChild(weekdayRow);

  const days = document.createElement('div');
  days.className = 'calendar-days';

  const startOfGrid = addDays(month, -month.getDay());
  const today = todayStr();

  for (let i = 0; i < 42; i++) {
    const date = addDays(startOfGrid, i);
    const key = dateKey(date);
    const inMonth = date.getMonth() === month.getMonth();

    const cell = document.createElement('div');
    cell.className = `calendar-cell${inMonth ? '' : ' outside'}${key === today ? ' today' : ''}`;

    const dayNum = document.createElement('div');
    dayNum.className = 'calendar-day-num';
    dayNum.textContent = date.getDate();
    cell.appendChild(dayNum);

    const dayItems = (itemsByDate.get(key) || []).slice().sort((a, b) => {
      const aDone = (a.kind === 'task' ? a.task.done : a.project.done) ? 1 : 0;
      const bDone = (b.kind === 'task' ? b.task.done : b.project.done) ? 1 : 0;
      return aDone - bDone;
    });

    dayItems.slice(0, maxPerDay).forEach((item) => {
      const isTask = item.kind === 'task';
      const record = isTask ? item.task : item.project;
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `calendar-pill priority-${record.priority || 'none'}${record.done ? ' done' : ''}`;
      pill.textContent = isTask ? record.text : record.name;
      pill.title = pill.textContent;
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        openItemPopup(record, !isTask);
      });
      cell.appendChild(pill);
    });

    if (dayItems.length > maxPerDay) {
      const more = document.createElement('div');
      more.className = 'calendar-more';
      more.textContent = `+${dayItems.length - maxPerDay} more`;
      cell.appendChild(more);
    }

    if (onAddDay) {
      cell.title = 'Click to add a task due this day';
      cell.addEventListener('click', () => onAddDay(key));
    }

    days.appendChild(cell);
  }

  grid.appendChild(days);
  return grid;
}

function renderCalendarView() {
  const wrap = document.createElement('div');
  wrap.className = 'calendar-view-panel';

  wrap.appendChild(renderCalendarToolbar(calendarMonth, (next) => {
    calendarMonth = next;
    render();
  }));

  const items = getCalendarItems(getVisibleLists());
  const byDate = groupCalendarItemsByDate(items);
  wrap.appendChild(renderCalendarGrid(calendarMonth, byDate, {
    maxPerDay: 4,
    onAddDay: (dateStr) => {
      const preset = activeListId !== 'all' ? (findList(activeListId)?.name || '') : '';
      openItemPopup(null, false, preset, dateStr);
    },
  }));

  return wrap;
}

function renderEmployeeMiniCalendar(list) {
  const panel = document.createElement('section');
  panel.className = 'list-column calendar-mini-panel';

  panel.appendChild(renderCalendarToolbar(calendarMonth, (next) => {
    calendarMonth = next;
    render();
  }));

  const items = getCalendarItems([list]);
  const byDate = groupCalendarItemsByDate(items);
  panel.appendChild(renderCalendarGrid(calendarMonth, byDate, {
    maxPerDay: 2,
    onAddDay: (dateStr) => openItemPopup(null, false, list.name, dateStr),
  }));

  return panel;
}

function renderEmptyState(text) {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = text;
  return empty;
}

// Opens the normal add-task/project popup, but pre-selects "+ New
// Project" so submitting the name field creates a project directly --
// reuses the exact same creation path the "+ New Project" option in
// that popup's own dropdown already takes.
function openNewProjectPopup(presetAssignee) {
  openItemPopup(null, false, presetAssignee);
  const select = document.getElementById('itemProjectSelect');
  if (select) select.value = '__new__';
}

function renderProjectEmptyState(personName) {
  const empty = document.createElement('div');
  empty.className = 'empty-state project-empty-state';
  empty.innerHTML = `
    <svg class="project-empty-icon" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
    </svg>
    <div class="project-empty-text">No projects yet.</div>
  `;
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'project-empty-add';
  addBtn.textContent = '+ Add Project';
  addBtn.addEventListener('click', () => openNewProjectPopup(personName));
  empty.appendChild(addBtn);
  return empty;
}

// ---------- KRA widget grid ----------

// Adds a scheme if the user typed a bare domain (e.g. "example.com"), since
// an <iframe src> with no scheme resolves relative to this page and fails.
function normalizeWidgetUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function widgetHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (err) {
    return url;
  }
}

function getActiveKraTab() {
  if (!Array.isArray(state.kraTabs) || !state.kraTabs.length) return null;
  return state.kraTabs.find((t) => t.id === state.activeKraTabId) || state.kraTabs[0];
}

function switchKraTab(tabId) {
  state.activeKraTabId = tabId;
  persist();
  render();
}

function addKraTab() {
  const name = prompt('Name this tab (e.g. News, Market, Research):');
  if (name === null) return;
  const tab = { id: uid('kratab'), name: name.trim() || 'New Tab', widgets: [] };
  if (!Array.isArray(state.kraTabs)) state.kraTabs = [];
  state.kraTabs.push(tab);
  state.activeKraTabId = tab.id;
  persist();
  render();
}

function renameKraTab(tab) {
  const name = prompt('Rename tab', tab.name);
  if (name === null || !name.trim()) return;
  tab.name = name.trim();
  persist();
  render();
}

function removeKraTab(tab) {
  if (state.kraTabs.length <= 1) {
    alert('At least one tab is required.');
    return;
  }
  if (!confirm(`Remove tab "${tab.name}"? Its widgets will be removed too.`)) return;
  state.kraTabs = state.kraTabs.filter((t) => t.id !== tab.id);
  if (state.activeKraTabId === tab.id) state.activeKraTabId = state.kraTabs[0].id;
  persist();
  render();
}

function openAddKraWidgetPopup(tab) {
  const { overlay, popup, confirmBtn } = openRegularPopup('Add Website', `
    <div style="margin-bottom:10px;">
      <label style="${FIELD_LABEL_STYLE}">Website URL *</label>
      <input type="text" id="kraWidgetUrl" placeholder="e.g. tradingview.com" autocomplete="off" style="${FIELD_STYLE}">
    </div>
    <div>
      <label style="${FIELD_LABEL_STYLE}">Title (optional)</label>
      <input type="text" id="kraWidgetTitle" placeholder="Defaults to the site's domain" autocomplete="off" style="${FIELD_STYLE}">
    </div>
    <p style="margin:10px 0 0;font-size:12px;color:#8a94a6;">Some sites (Google, banking, social media) block being embedded this way — those will show an empty widget, but "Open in new tab" still works.</p>
  `, { confirmLabel: 'Add' });

  setTimeout(() => popup.querySelector('#kraWidgetUrl').focus(), 100);

  confirmBtn.addEventListener('click', () => {
    const url = normalizeWidgetUrl(popup.querySelector('#kraWidgetUrl').value);
    if (!url) { alert('Please enter a website URL'); return; }
    const title = popup.querySelector('#kraWidgetTitle').value.trim();
    if (!Array.isArray(tab.widgets)) tab.widgets = [];
    tab.widgets.push({ id: uid('kra'), url, title });
    persist();
    overlay.remove();
    render();
  });
}

function renderKraWorkspace() {
  const wrap = document.createElement('div');
  wrap.className = 'kra-workspace';

  const activeTab = getActiveKraTab();
  // Tab navigation (switch/rename/remove/add) lives in the sidebar's Tabs
  // group on desktop -- but the sidebar is hidden on mobile entirely, so
  // mobile got no way to switch tabs, see what other tabs exist, or add
  // one. This strip duplicates just that (switch/add/remove) inline,
  // CSS-gated to only show up at the same breakpoint the sidebar disappears.
  const mobileStrip = document.createElement('div');
  mobileStrip.className = 'kra-mobile-tabstrip';
  (state.kraTabs || []).forEach((tab) => {
    const pillWrap = document.createElement('div');
    pillWrap.className = 'kra-mobile-tab-pill-wrap';
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `kra-mobile-tab-pill${activeTab && tab.id === activeTab.id ? ' active' : ''}`;
    pill.textContent = tab.name;
    pill.addEventListener('click', () => switchKraTab(tab.id));
    pillWrap.appendChild(pill);
    if ((state.kraTabs || []).length > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'kra-mobile-tab-remove';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = 'Remove tab';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeKraTab(tab);
      });
      pillWrap.appendChild(removeBtn);
    }
    mobileStrip.appendChild(pillWrap);
  });
  const addTabPill = document.createElement('button');
  addTabPill.type = 'button';
  addTabPill.className = 'kra-mobile-tab-pill kra-mobile-tab-add';
  addTabPill.textContent = '+ New tab';
  addTabPill.addEventListener('click', () => addKraTab());
  mobileStrip.appendChild(addTabPill);
  wrap.appendChild(mobileStrip);

  dashboardTitleEl.textContent = activeTab ? `Tabs — ${activeTab.name}` : 'Tabs';

  if (!activeTab) return wrap;

  // The add-website action lives in the viewbar itself (see
  // setViewbarActions), in the same spot Archived/+Add/+New list occupy
  // for the main board, instead of a second toolbar row inside the
  // workspace -- that second row was what pushed the actual content down
  // below where the equivalent main-board content starts. Mobile hides
  // the viewbar entirely though, so it also gets its own copy of this
  // button (CSS-gated the same way as the tab strip above).
  kraViewActionsEl.innerHTML = '';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tab-add has-archived';
  addBtn.textContent = '+ Add Website';
  addBtn.addEventListener('click', () => openAddKraWidgetPopup(activeTab));
  kraViewActionsEl.appendChild(addBtn);

  const mobileAddBtn = document.createElement('button');
  mobileAddBtn.type = 'button';
  mobileAddBtn.className = 'kra-mobile-add-website';
  mobileAddBtn.textContent = '+ Add Website';
  mobileAddBtn.addEventListener('click', () => openAddKraWidgetPopup(activeTab));
  wrap.appendChild(mobileAddBtn);

  const widgets = activeTab.widgets || [];
  if (!widgets.length) {
    wrap.appendChild(renderEmptyState(`No websites in "${activeTab.name}" yet. Click "+ Add Website" to get started.`));
    return wrap;
  }

  const grid = document.createElement('div');
  grid.className = 'kra-grid';
  widgets.forEach((widget) => grid.appendChild(renderKraWidget(widget, activeTab)));
  wrap.appendChild(grid);

  return wrap;
}

function renderKraWidget(widget, tab) {
  const card = document.createElement('div');
  card.className = 'kra-widget';
  card.dataset.widgetId = widget.id;
  makeResizable(card, `kra:${widget.id}`);
  card.draggable = true;
  card.style.cursor = 'grab';

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', widget.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData('text/plain');
    if (fromId === widget.id) return;
    const widgets = tab.widgets;
    const fromIndex = widgets.findIndex((w) => w.id === fromId);
    const toIndex = widgets.findIndex((w) => w.id === widget.id);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = widgets.splice(fromIndex, 1);
    widgets.splice(toIndex, 0, moved);
    persist();
    render();
  });

  const head = document.createElement('div');
  head.className = 'kra-widget-head';

  const titleEl = document.createElement('span');
  titleEl.className = 'kra-widget-title';
  titleEl.textContent = widget.title || widgetHostname(widget.url);
  titleEl.title = widget.url;
  head.appendChild(titleEl);

  const actions = document.createElement('div');
  actions.className = 'kra-widget-actions';

  // Some sites block direct embedding (X-Frame-Options). This toggle re-loads
  // the widget through the /api/proxy serverless function instead, which
  // fetches the page server-side and strips that restriction — only worth
  // trying for public/no-login pages, since the proxy doesn't carry cookies.
  const proxyToggle = document.createElement('button');
  proxyToggle.type = 'button';
  proxyToggle.className = 'kra-widget-action kra-widget-proxy-toggle';
  proxyToggle.classList.toggle('active', Boolean(widget.viaProxy));
  proxyToggle.title = widget.viaProxy
    ? 'Viewing via proxy — click to go back to loading it directly'
    : 'Widget blank? Click to try loading this site through the proxy';
  proxyToggle.innerHTML = '&#8635;';
  proxyToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    widget.viaProxy = !widget.viaProxy;
    persist();
    render();
  });
  actions.appendChild(proxyToggle);

  const openLink = document.createElement('a');
  openLink.className = 'kra-widget-action';
  openLink.href = widget.url;
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.title = 'Open in new tab';
  openLink.innerHTML = '&#8599;';
  openLink.addEventListener('click', (e) => e.stopPropagation());
  actions.appendChild(openLink);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'kra-widget-action kra-widget-remove';
  removeBtn.title = 'Remove widget';
  removeBtn.innerHTML = '&times;';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm(`Remove "${titleEl.textContent}"?`)) return;
    tab.widgets = (tab.widgets || []).filter((w) => w.id !== widget.id);
    persist();
    render();
  });
  actions.appendChild(removeBtn);

  head.appendChild(actions);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'kra-widget-body';
  const iframe = document.createElement('iframe');
  iframe.src = widget.viaProxy ? `/api/proxy?url=${encodeURIComponent(widget.url)}` : widget.url;
  iframe.loading = 'lazy';
  iframe.title = widget.title || widgetHostname(widget.url);
  body.appendChild(iframe);
  card.appendChild(body);

  return card;
}

function textCell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function openDatePicker(list, task, dueEl) {
  const input = document.createElement('input');
  input.type = 'date';
  input.value = task.due || '';
  input.style.position = 'absolute';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const newDue = input.value || null;
    const oldDue = task.due;

    // Check if due date is actually changing
    if (newDue !== oldDue) {
      const changeCount = (task.dueChangeCount || 0) + 1;
      const container = list.container || 'lists';
      const context = container === 'projects' ? 'project' : 'task';

      const confirmed = confirm(
        `Due date change count for this ${context}: ${changeCount}\n\n` +
        `You are about to change the due date from "${oldDue || 'none'}" to "${newDue || 'none'}".\n\n` +
        `Do you want to proceed with this change?`
      );

      if (confirmed) {
        task.due = newDue;
        task.dueChangeCount = changeCount;
        logBoardEvent('due_changed', `Due date changed on "${task.text}": ${oldDue || 'none'} → ${newDue || 'none'}`);
        persist();
        render();
      }
    }

    input.remove();
  });
  input.addEventListener('blur', () => setTimeout(() => input.remove(), 200));
  if (input.showPicker) input.showPicker(); else input.click();
}

// ---------- task popup ----------

function getAllEmployees() {
  const employees = getRegisteredEmployees();
  return employees.map((e) => e.name || e.email).sort();
}


function escapeHtml(str) {
  return String(str || '').replace(/[&<>"]/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
}

// ---------- mutations ----------

function addTask(list, sectionId, taskData) {
  // If an Assigned To value matches an existing list name, add the task to
  // that person's list instead of the currently-open list. Only applies to
  // the main task-board lists — a task added inside a project should stay
  // in that project regardless of who it's assigned to.
  const belongsToMainLists = state.lists.some((l) => l.id === list.id);
  const assigned = (taskData.assignedTo || '').trim();
  let targetList = list;
  if (belongsToMainLists && assigned) {
    const found = state.lists.find((l) => sameEmployee(l.name, assigned));
    if (found) targetList = found;
  }

  targetList.tasks.push({
    id: uid('task'),
    text: taskData.text || 'Untitled task',
    priority: taskData.priority || 'none',
    due: taskData.due || null,
    startDate: taskData.startDate || null,
    createdAt: Date.now(),
    completedAt: null,
    done: false,
    status: taskData.status || 'pending',
    sectionId: targetList === list ? (sectionId || null) : null,
    dueChangeCount: 0,
    assignedTo: taskData.assignedTo || '',
    mood: taskData.mood || 'neutral',
    description: taskData.description || '',
    progress: 0,
    category: taskData.category || '',
  });
  const forWhom = taskData.assignedTo ? ` (${taskData.assignedTo})` : '';
  logBoardEvent('task_created', `Task added: "${taskData.text || 'Untitled task'}"${forWhom}`);
  persist();
}

function attachFluidProgressDrag(barEl, currentVal, onCommit) {
  const updateVisuals = (val) => {
    barEl.style.setProperty('--p', `${val}%`);
    let color = '#1F4690';
    if (val < 40) color = 'var(--medium)';
    else if (val < 70) color = 'var(--accent)';
    barEl.style.setProperty('--c', color);
    barEl.title = `Progress: ${val}% (Drag to adjust)`;
  };

  updateVisuals(currentVal);

  let isDragging = false;
  let startY = 0;
  
  const getValFromEvent = (e) => {
    const rect = barEl.getBoundingClientRect();
    let y = e.clientY - rect.top;
    y = Math.max(0, Math.min(rect.height, y));
    const percent = 100 - Math.round((y / rect.height) * 100);
    return percent;
  };

  barEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    isDragging = true;
    startY = e.clientY;
    barEl.setPointerCapture(e.pointerId);
  });

  barEl.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    e.stopPropagation();
    if (Math.abs(e.clientY - startY) > 3) {
      updateVisuals(getValFromEvent(e));
    }
  });

  barEl.addEventListener('pointerup', (e) => {
    if (!isDragging) return;
    e.stopPropagation();
    isDragging = false;
    barEl.releasePointerCapture(e.pointerId);
    
    let val;
    if (Math.abs(e.clientY - startY) <= 3) {
      // It was a click, cycle by 25%
      val = currentVal >= 100 ? 0 : Math.min(100, (Math.floor(currentVal / 25) + 1) * 25);
    } else {
      // It was a drag, use the fluid value
      val = getValFromEvent(e);
    }
    
    updateVisuals(val);
    if (onCommit) onCommit(val);
  });

  barEl.addEventListener('pointercancel', (e) => {
    if (!isDragging) return;
    isDragging = false;
    barEl.releasePointerCapture(e.pointerId);
    updateVisuals(currentVal); // revert visually
  });
}

function toggleDone(list, task) {
  const wasDone = task.done;
  task.done = !task.done;
  task.completedAt = task.done ? Date.now() : null;
  task.progress = task.done ? 100 : (task.progress === 100 ? 0 : task.progress);
  task.status = task.done ? 'Done' : (task.progress === 0 ? 'Pending' : task.status);
  if (task.done && !wasDone) {
    fireConfetti();
    logBoardEvent('task_completed', `Task completed: "${task.text}"`);
  }
  persist();
  render();
}

function setTaskProgress(list, task, value) {
  const wasDone = task.done;
  task.progress = value;
  task.done = value === 100;
  task.completedAt = task.done ? Date.now() : null;
  task.status = value === 100 ? 'Done' : (value === 0 ? 'Pending' : 'In Progress');
  if (task.done && !wasDone) {
    fireConfetti();
    logBoardEvent('task_completed', `Task completed: "${task.text}"`);
  }
  persist();
  render();
}

function setProjectProgress(project, value) {
  const wasDone = project.done;
  project.progress = value;
  project.done = value === 100;
  project.completedAt = project.done ? Date.now() : null;
  project.status = value === 100 ? 'Done' : (value === 0 ? 'Pending' : 'In Progress');
  if (project.done && !wasDone) {
    fireConfetti();
    logBoardEvent('project_completed', `Project completed: "${project.name}"`);
  }
  persist();
  render();
}

function cycleListMood(list) {
  const order = ['neutral', 'happy', 'sad', 'busy'];
  const idx = Math.max(0, order.indexOf(list.mood));
  list.mood = order[(idx + 1) % order.length];
  persist();
  render();
}

function deleteTask(list, task) {
  const idx = list.tasks.findIndex((t) => t.id === task.id);
  const removed = list.tasks.splice(idx, 1)[0];
  list.deletedTasks = list.deletedTasks || [];
  const entry = { id: uid('del'), task: removed, deletedAt: Date.now(), reason: null };
  list.deletedTasks.unshift(entry);
  if (list.deletedTasks.length > DELETED_TASKS_RETENTION) list.deletedTasks.length = DELETED_TASKS_RETENTION;
  logBoardEvent('task_deleted', `Task deleted: "${removed.text}"`);
  persist();
  render();
  showToast(`Deleted "${removed.text}"`, () => {
    list.tasks.splice(idx, 0, removed);
    list.deletedTasks = list.deletedTasks.filter((e) => e.id !== entry.id);
    logBoardEvent('task_restored', `Task restored: "${removed.text}"`);
    persist();
    render();
  });
}

function restoreDeletedTask(list, entryId) {
  const idx = (list.deletedTasks || []).findIndex((e) => e.id === entryId);
  if (idx === -1) return;
  const [entry] = list.deletedTasks.splice(idx, 1);
  list.tasks.push(entry.task);
  logBoardEvent('task_restored', `Task restored: "${entry.task.text}"`);
  persist();
  render();
  showToast(`Restored "${entry.task.text}"`);
}

function permanentlyDeleteTask(list, entryId) {
  const idx = (list.deletedTasks || []).findIndex((e) => e.id === entryId);
  if (idx === -1) return;
  list.deletedTasks.splice(idx, 1);
  persist();
  render();
}

function addList(name, ownerEmail = null) {
  const list = { id: uid('list'), name, ownerEmail: ownerEmail || null, sections: [], tasks: [] };
  state.lists.push(list);
  activeListId = list.id;
  persist();
  render();
}

function openArchivedListsMenu(anchorEl) {
  document.querySelectorAll('.archived-lists-popup').forEach((m) => m.remove());

  const menu = document.createElement('div');
  menu.className = 'status-dropdown-popup archived-lists-popup';

  const archivedLists = getArchivedLists().map((l) => ({ item: l, isProject: false }));
  const archivedProjects = getArchivedProjects().map((p) => ({ item: p, isProject: true }));
  const archived = [...archivedLists, ...archivedProjects];

  if (!archived.length) {
    const empty = document.createElement('div');
    empty.className = 'archived-empty';
    empty.textContent = 'Nothing archived. Archive a list or project from its "⋮" menu when someone leaves.';
    menu.appendChild(empty);
  } else {
    archived
      .sort((a, b) => (b.item.archivedAt || 0) - (a.item.archivedAt || 0))
      .forEach(({ item, isProject }) => {
        const row = document.createElement('div');
        row.className = 'archived-row';

        const info = document.createElement('div');
        info.className = 'archived-info';
        const name = document.createElement('span');
        name.className = 'archived-name';
        name.textContent = `${item.name}${isProject ? ' (project)' : ''}`;
        info.appendChild(name);
        const meta = document.createElement('span');
        meta.className = 'archived-meta';
        const openCount = item.tasks.filter((t) => !t.done).length;
        meta.textContent = `${item.tasks.length} task${item.tasks.length === 1 ? '' : 's'} · ${openCount} open${item.archivedAt ? ` · archived ${fmtShort(item.archivedAt)}` : ''}`;
        info.appendChild(meta);
        row.appendChild(info);

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'archived-restore';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          item.archived = false;
          item.archivedAt = null;
          if (!isProject) activeListId = item.id;
          persist();
          menu.remove();
          render();
          showToast(`Restored "${item.name}"`);
        });
        row.appendChild(restoreBtn);

        menu.appendChild(row);
      });
  }

  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  menu.style.position = 'absolute';
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  if (rect.left + menuWidth > window.innerWidth - 12) {
    menu.style.left = `${rect.right + window.scrollX - menuWidth}px`;
  } else {
    menu.style.left = `${rect.left + window.scrollX}px`;
  }
  menu.style.zIndex = '1000';

  const closeMenu = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorEl) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('scroll', closeOnScroll, true);
    }
  };
  const closeOnScroll = () => {
    menu.remove();
    document.removeEventListener('click', closeMenu);
    document.removeEventListener('scroll', closeOnScroll, true);
  };
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('scroll', closeOnScroll, true);
  }, 0);
}

// ---------- analytics / charts ----------

function getRegularCompletionDates(employeeFilter = 'all') {
  const completions = state.regular?.completions || {};
  const tasksById = new Map((state.regular?.tasks || []).map((task) => [task.id, task]));
  return Object.keys(completions)
    .filter((key) => completions[key])
    .map((key) => {
      const [taskId, datePart] = key.split(':');
      if (employeeFilter !== 'all') {
        const task = tasksById.get(taskId);
        if (!task || task.owner !== employeeFilter) return null;
      }
      if (!datePart) return null;
      const [y, m, d] = datePart.split('-').map(Number);
      if (!y || !m || !d) return null;
      return new Date(y, m - 1, d);
    })
    .filter(Boolean);
}

function weekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  return addDays(d, diff);
}

function chartCadenceProgress() {
  const dates = getRegularDates();
  const tasks = (state.regular?.tasks || []).filter((task) => activeRegularEmployee === 'all' || sameEmployee(task.owner, activeRegularEmployee));
  return ['daily', 'weekly', 'monthly'].map((cadence) => {
    const cadenceTasks = tasks.filter((task) => task.cadence === cadence);
    const totals = cadenceTasks.reduce((acc, task) => {
      const progress = regularTaskProgress(task, dates);
      acc.done += progress.done;
      acc.total += progress.total;
      return acc;
    }, { done: 0, total: 0 });
    return { label: cadenceLabel(cadence), value: totals.total ? Math.round((totals.done / totals.total) * 100) : 0 };
  });
}

// Replaces the old daily/weekly/monthly/yearly completions bar-lists --
// four separate cards showing mostly the same "completions over time"
// story sliced into different windows read as noise more than signal.
// One trend line, one weekday histogram, and one activity heatmap cover
// the same ground more clearly.
function chartCompletionsTrend(days = 30) {
  const dates = getRegularCompletionDates(activeRegularEmployee);
  const range = Array.from({ length: days }, (_, i) => addDays(new Date(), -(days - 1 - i)));
  return range.map((day) => {
    const key = dateKey(day);
    const count = dates.filter((d) => dateKey(d) === key).length;
    return { label: `${day.getDate()} ${MONTHS[day.getMonth()]}`, value: count };
  });
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function chartCompletionsByWeekday() {
  const dates = getRegularCompletionDates(activeRegularEmployee);
  const counts = [0, 0, 0, 0, 0, 0, 0];
  dates.forEach((d) => { counts[(d.getDay() + 6) % 7] += 1; });
  return WEEKDAY_LABELS.map((label, i) => ({ label, value: counts[i] }));
}

function chartCompletionsHeatmap(weeks = 14) {
  const dates = getRegularCompletionDates(activeRegularEmployee);
  const counts = new Map();
  dates.forEach((d) => {
    const key = dateKey(d);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const start = addDays(weekStart(new Date()), -7 * (weeks - 1));
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  return days.map((day) => ({ date: day, count: counts.get(dateKey(day)) || 0 }));
}

function chartPriorityBreakdown() {
  const tasks = state.lists.flatMap((list) => list.tasks);
  const counts = { none: 0, low: 0, medium: 0, high: 0 };
  tasks.forEach((task) => { counts[task.priority || 'none'] += 1; });
  return [
    { label: 'High', value: counts.high, color: 'var(--high)' },
    { label: 'Medium', value: counts.medium, color: 'var(--medium)' },
    { label: 'Low', value: counts.low, color: 'var(--low)' },
    { label: 'None', value: counts.none, color: 'var(--done)' },
  ];
}

function chartStatusBreakdown() {
  const tasks = state.lists.flatMap((list) => list.tasks);
  const today = todayStr();
  const done = tasks.filter((task) => task.done).length;
  const overdue = tasks.filter((task) => !task.done && task.due && task.due < today).length;
  const open = tasks.filter((task) => !task.done).length - overdue;
  return [
    { label: 'Open', value: Math.max(open, 0), color: 'var(--accent)' },
    { label: 'Overdue', value: overdue, color: 'var(--danger)' },
    { label: 'Done', value: done, color: '#1F4690' },
  ];
}

function chartTasksPerList() {
  return state.lists.map((list) => ({
    label: list.name,
    value: list.tasks.filter((task) => !task.done).length,
    color: listAccentColor(list.id),
  }));
}

function chartEmployeeProgress() {
  const allEmployees = state.regular?.employees || [];
  const employees = activeRegularEmployee === 'all' ? allEmployees : allEmployees.filter((e) => sameEmployee(e, activeRegularEmployee));
  const dates = getRegularDates();
  return employees.map((owner) => {
    const tasks = (state.regular?.tasks || []).filter((task) => task.owner === owner);
    const totals = tasks.reduce((acc, task) => {
      const progress = regularTaskProgress(task, dates);
      acc.done += progress.done;
      acc.total += progress.total;
      return acc;
    }, { done: 0, total: 0 });
    return { label: owner, value: totals.total ? Math.round((totals.done / totals.total) * 100) : 0 };
  });
}

function renderChartCard(title, subtitle, contentEl) {
  const card = document.createElement('article');
  card.className = 'chart-card';
  const head = document.createElement('div');
  head.className = 'chart-card-head';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  head.appendChild(h3);
  if (subtitle) {
    const sub = document.createElement('span');
    sub.className = 'chart-card-sub';
    sub.textContent = subtitle;
    head.appendChild(sub);
  }
  card.appendChild(head);
  card.appendChild(contentEl);
  return card;
}

function renderChartEmptyState(text = 'No data recorded yet') {
  const empty = document.createElement('div');
  empty.className = 'chart-empty-state';
  empty.innerHTML = `
    <div class="chart-empty-icon">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="var(--secondary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
      </svg>
    </div>
    <div class="chart-empty-text">${escapeHtml(text)}</div>
    <div class="chart-empty-hint">Metrics will automatically update as tasks and completions are recorded</div>
  `;
  return empty;
}

// Vertical bars (a proper column chart) instead of the old horizontal
// label/track/value rows -- reads as an actual chart at a glance instead
// of a stack of progress bars, and gives Analytics some visual variety
// alongside the pie/line/heatmap charts.
function renderColumnChart({ data, color = 'var(--accent)', maxValue, valueFormatter }) {
  const wrap = document.createElement('div');
  wrap.className = 'column-chart';
  if (!data.length) {
    wrap.appendChild(renderChartEmptyState('No data recorded yet.'));
    return wrap;
  }
  const max = maxValue != null ? maxValue : Math.max(1, ...data.map((d) => d.value));
  data.forEach((d, i) => {
    const col = document.createElement('div');
    col.className = 'column-item';
    col.style.animationDelay = `${Math.min(i * 40, 400)}ms`;

    const value = document.createElement('span');
    value.className = 'column-value';
    value.textContent = valueFormatter ? valueFormatter(d.value) : d.value;
    col.appendChild(value);

    const track = document.createElement('span');
    track.className = 'column-track';
    const fill = document.createElement('span');
    fill.className = 'column-fill';
    const pct = max ? Math.max(d.value > 0 ? 2 : 0, (d.value / max) * 100) : 0;
    fill.style.height = `${pct}%`;
    fill.style.background = d.color || color;
    fill.title = `${d.label}: ${valueFormatter ? valueFormatter(d.value) : d.value}`;
    track.appendChild(fill);
    col.appendChild(track);

    const label = document.createElement('span');
    label.className = 'column-label';
    label.textContent = d.label;
    col.appendChild(label);

    wrap.appendChild(col);
  });
  return wrap;
}

function renderLineChart({ data, color = 'var(--accent)', valueFormatter, width = 520, height = 200 }) {
  const wrap = document.createElement('div');
  wrap.className = 'line-chart';
  if (!data.length || !data.some((d) => d.value > 0)) {
    wrap.appendChild(renderChartEmptyState('No completion data yet.'));
    return wrap;
  }

  const padX = 8;
  const padY = 16;
  const max = Math.max(1, ...data.map((d) => d.value));
  const stepX = data.length > 1 ? (width - padX * 2) / (data.length - 1) : 0;
  const points = data.map((d, i) => {
    const x = padX + i * stepX;
    const y = padY + (1 - d.value / max) * (height - padY * 2);
    return { x, y, d };
  });

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('line-svg');

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${height - padY} L${points[0].x.toFixed(1)},${height - padY} Z`;

  const area = document.createElementNS(svgNS, 'path');
  area.setAttribute('d', areaPath);
  area.classList.add('line-area');
  area.setAttribute('fill', color);
  svg.appendChild(area);

  const line = document.createElementNS(svgNS, 'path');
  line.setAttribute('d', linePath);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.classList.add('line-stroke');
  svg.appendChild(line);

  points.forEach(({ x, y, d }) => {
    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('cx', x.toFixed(1));
    dot.setAttribute('cy', y.toFixed(1));
    dot.setAttribute('r', 3);
    dot.setAttribute('fill', color);
    dot.classList.add('line-dot');
    const titleEl = document.createElementNS(svgNS, 'title');
    titleEl.textContent = `${d.label}: ${valueFormatter ? valueFormatter(d.value) : d.value}`;
    dot.appendChild(titleEl);
    svg.appendChild(dot);
  });

  wrap.appendChild(svg);

  const axis = document.createElement('div');
  axis.className = 'line-axis';
  // Only a handful of labels, evenly spaced, so 30 daily points don't
  // crowd into unreadable text.
  const labelCount = Math.min(6, data.length);
  const labelStep = Math.max(1, Math.round((data.length - 1) / (labelCount - 1)));
  data.forEach((d, i) => {
    if (i % labelStep !== 0 && i !== data.length - 1) return;
    const tick = document.createElement('span');
    tick.textContent = d.label;
    axis.appendChild(tick);
  });
  wrap.appendChild(axis);

  return wrap;
}

const HEATMAP_LEVEL_COLORS = ['rgba(31, 70, 144, 0.08)', 'rgba(31, 70, 144, 0.32)', 'rgba(31, 70, 144, 0.58)', 'rgba(31, 70, 144, 0.85)', '#1F4690'];
function renderHeatmap({ data }) {
  const wrap = document.createElement('div');
  wrap.className = 'heatmap-chart';
  if (!data.some((d) => d.count > 0)) {
    wrap.appendChild(renderChartEmptyState('No completion data yet.'));
    return wrap;
  }

  const max = Math.max(1, ...data.map((d) => d.count));
  const levelFor = (count) => {
    if (!count) return 0;
    const frac = count / max;
    return Math.min(4, Math.max(1, Math.ceil(frac * 4)));
  };

  const row = document.createElement('div');
  row.className = 'heatmap-row';

  const weekdayCol = document.createElement('div');
  weekdayCol.className = 'heatmap-weekdays';
  ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach((label) => {
    const span = document.createElement('span');
    span.textContent = label;
    weekdayCol.appendChild(span);
  });
  row.appendChild(weekdayCol);

  const grid = document.createElement('div');
  grid.className = 'heatmap-grid';
  const weeks = data.length / 7;
  grid.style.gridTemplateColumns = `repeat(${weeks}, 1fr)`;
  data.forEach(({ date, count }) => {
    const cell = document.createElement('span');
    cell.className = 'heatmap-cell';
    cell.style.background = HEATMAP_LEVEL_COLORS[levelFor(count)];
    cell.title = `${fmtShort(date.getTime())}: ${count} completion${count === 1 ? '' : 's'}`;
    grid.appendChild(cell);
  });
  row.appendChild(grid);
  wrap.appendChild(row);

  const legend = document.createElement('div');
  legend.className = 'heatmap-legend';
  const lessLabel = document.createElement('span');
  lessLabel.textContent = 'Less';
  legend.appendChild(lessLabel);
  HEATMAP_LEVEL_COLORS.forEach((c) => {
    const sw = document.createElement('span');
    sw.className = 'heatmap-swatch';
    sw.style.background = c;
    legend.appendChild(sw);
  });
  const moreLabel = document.createElement('span');
  moreLabel.textContent = 'More';
  legend.appendChild(moreLabel);
  wrap.appendChild(legend);

  return wrap;
}

function renderPieChart({ data, size = 148, thickness = 26 }) {
  const wrap = document.createElement('div');
  wrap.className = 'pie-chart';
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (!total) {
    wrap.appendChild(renderChartEmptyState('No task data recorded yet.'));
    return wrap;
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.classList.add('pie-svg');

  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const cx = size / 2;
  const cy = size / 2;

  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('cx', cx);
  track.setAttribute('cy', cy);
  track.setAttribute('r', radius);
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'var(--border)');
  track.setAttribute('stroke-width', thickness);
  svg.appendChild(track);

  let offset = 0;
  data.forEach((d, i) => {
    if (!d.value) return;
    const fraction = d.value / total;
    const dash = fraction * circumference;
    const gap = circumference - dash;
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', radius);
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', d.color);
    circle.setAttribute('stroke-width', thickness);
    circle.setAttribute('stroke-dasharray', `${Math.max(dash - 2, 0)} ${gap + 2}`);
    circle.setAttribute('stroke-dashoffset', String(-offset));
    circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
    circle.classList.add('pie-slice');
    circle.style.animationDelay = `${i * 80}ms`;
    const titleEl = document.createElementNS(svgNS, 'title');
    titleEl.textContent = `${d.label}: ${d.value} (${Math.round(fraction * 100)}%)`;
    circle.appendChild(titleEl);
    svg.appendChild(circle);
    offset += dash;
  });

  // Donut center text
  const totalText = document.createElementNS(svgNS, 'text');
  totalText.setAttribute('x', cx);
  totalText.setAttribute('y', cy - 5);
  totalText.setAttribute('text-anchor', 'middle');
  totalText.setAttribute('fill', 'var(--text-muted)');
  totalText.setAttribute('font-size', '9px');
  totalText.setAttribute('font-weight', '700');
  totalText.setAttribute('letter-spacing', '0.5px');
  totalText.textContent = 'TOTAL';
  svg.appendChild(totalText);

  const numText = document.createElementNS(svgNS, 'text');
  numText.setAttribute('x', cx);
  numText.setAttribute('y', cy + 13);
  numText.setAttribute('text-anchor', 'middle');
  numText.setAttribute('fill', 'var(--text)');
  numText.setAttribute('font-size', '18px');
  numText.setAttribute('font-weight', '800');
  numText.textContent = total;
  svg.appendChild(numText);

  wrap.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'pie-legend';
  data.forEach((d) => {
    const item = document.createElement('div');
    item.className = 'pie-legend-item';

    const leftWrap = document.createElement('div');
    leftWrap.style.display = 'flex';
    leftWrap.style.alignItems = 'center';
    leftWrap.style.gap = '8px';

    const swatch = document.createElement('span');
    swatch.className = 'pie-swatch';
    swatch.style.background = d.color;
    leftWrap.appendChild(swatch);

    const labelSpan = document.createElement('span');
    labelSpan.className = 'legend-label';
    labelSpan.textContent = d.label;
    leftWrap.appendChild(labelSpan);

    item.appendChild(leftWrap);

    const valSpan = document.createElement('strong');
    valSpan.className = 'legend-value';
    const pct = total ? Math.round((d.value / total) * 100) : 0;
    valSpan.textContent = `${d.value} (${pct}%)`;
    item.appendChild(valSpan);

    legend.appendChild(item);
  });
  wrap.appendChild(legend);

  return wrap;
}

// ---------- Productivity report ----------

function productivityDateStrDiffDays(laterStr, earlierStr) {
  const later = new Date(`${laterStr}T00:00:00`);
  const earlier = new Date(`${earlierStr}T00:00:00`);
  return Math.round((later - earlier) / 86400000);
}

function productivityResultLabel(item) {
  if (item.done) return 'Completed';
  if (itemDisplayProgress(item) > 0) return 'In Progress';
  return 'Not Started';
}

function productivityDeliveryInfo(item) {
  const due = item.due || item.dueDate || null;
  if (!item.done || !due || !item.completedAt) return { text: '—', cls: 'neutral', diff: null };
  const completedKey = dateKey(new Date(item.completedAt));
  const diff = productivityDateStrDiffDays(completedKey, due);
  if (diff === 0) return { text: 'On time', cls: 'ontime', diff };
  if (diff > 0) return { text: `${diff} day${diff === 1 ? '' : 's'} late`, cls: 'late', diff };
  const early = Math.abs(diff);
  return { text: `${early} day${early === 1 ? '' : 's'} early`, cls: 'early', diff };
}

// Per-row version of the same ingredients the scorecard above uses
// (priority weight, done/not-done, timeliness) so "which task is getting
// what score" is answered with the same logic, not a separate formula --
// see openScoringAlgorithmInfoPopup() for the plain-language version of
// this shown to the user.
function productivityRowScore(row) {
  if (row.kind === 'regular') {
    const occ = row.occurrences || { done: 0, total: 0 };
    return occ.total > 0 ? Math.round((occ.done / occ.total) * 100) : null;
  }

  const due = row.due || row.dueDate || null;
  const today = todayStr();

  if (row.done) {
    if (due && row.completedAt) {
      return Math.round(timelinessScoreForDiff(productivityDeliveryInfo(row).diff));
    }
    return 100; // Done, with no due date to judge lateness against.
  }

  if (due && due < today) {
    const daysOverdue = productivityDateStrDiffDays(today, due);
    return Math.round(productivityClamp(50 - 50 * (daysOverdue / PRODUCTIVITY_TIMELINESS_LATE_CAP_DAYS), 0, 50));
  }

  // Not done yet, not overdue -- scored on progress made so far.
  return Math.round(productivityClamp(itemDisplayProgress(row), 0, 100));
}

// A task/project belongs in the report if EITHER its start date or its
// due date falls inside the selected range -- not due-date-only. Otherwise
// something started inside the range but due after it (or vice versa)
// would silently vanish from the report even though real work on it
// happened during that window.
function productivityInRange(item, from, to) {
  const due = item.due || item.dueDate || null;
  const start = item.startDate || null;
  const dueInRange = Boolean(due) && due >= from && due <= to;
  const startInRange = Boolean(start) && start >= from && start <= to;
  return dueInRange || startInRange;
}

function productivityMatchesEmployee(employee, candidate) {
  return employee === PRODUCTIVITY_ALL_EMPLOYEES || sameEmployee(candidate, employee);
}

function productivityMatchesAnyEmployee(employee, candidates) {
  return employee === PRODUCTIVITY_ALL_EMPLOYEES || (candidates || []).some((o) => sameEmployee(o, employee));
}

function buildProductivityTaskRows(employee, category, from, to) {
  const matchesCategory = (item) => !category || item.category === category;
  return state.lists.flatMap((list) => list.tasks)
    .filter((t) => productivityMatchesEmployee(employee, t.assignedTo) && matchesCategory(t) && productivityInRange(t, from, to))
    .map((t) => ({ kind: 'task', name: t.text, category: t.category, priority: t.priority, startDate: t.startDate, due: t.due, done: t.done, progress: t.progress, status: t.status, completedAt: t.completedAt, assignedTo: t.assignedTo }));
}

function buildProductivityProjectRows(employee, category, from, to) {
  const matchesCategory = (item) => !category || item.category === category;
  return (state.projects || [])
    .filter((p) => !p.archived && !p.deleted && productivityMatchesAnyEmployee(employee, p.owners) && matchesCategory(p) && productivityInRange(p, from, to))
    .map((p) => ({ kind: 'project', name: p.name, category: p.category, priority: p.priority, startDate: p.startDate, due: p.dueDate, done: p.done, progress: p.progress, status: p.status, completedAt: p.completedAt, owners: p.owners }));
}

// Regular tasks recur (daily/weekly/monthly/...) instead of having a single
// start/due date, so there's no natural "one row per occurrence" without the
// table exploding to hundreds of rows for a daily task over a wide range.
// One row per regular task instead, with Status/Result reflecting its
// completion rate across every expected occurrence in the selected range --
// Start/Due/Delivery don't apply to a recurring task, so they render as "—".
function buildProductivityRegularRows(employee, category, from, to) {
  const matchesCategory = (item) => !category || item.category === category;
  const dates = productivityDateRangeArray(from, to);
  return (state.regular?.tasks || [])
    .filter((t) => productivityMatchesEmployee(employee, t.owner) && matchesCategory(t))
    .map((t) => {
      const p = regularTaskProgress(t, dates);
      return { kind: 'regular', name: t.title, category: t.category, priority: t.priority && t.priority !== 'none' ? t.priority : null, startDate: null, due: null, done: p.total > 0 && p.done >= p.total, progress: p.pct, completedAt: null, occurrences: p };
    })
    .filter((row) => row.occurrences.total > 0);
}

// ---------- Productivity report: unified sheet (sort + filter) ----------

const PRODUCTIVITY_COLUMNS = [
  { key: 'name', label: 'Task' },
  { key: 'category', label: 'Category' },
  { key: 'priority', label: 'Priority' },
  { key: 'startDate', label: 'Start Date' },
  { key: 'due', label: 'Due Date' },
  { key: 'completedAt', label: 'Complete Date' },
  { key: 'status', label: 'Status' },
  { key: 'result', label: 'Result' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'score', label: 'Score' },
];

const PRODUCTIVITY_PRIORITY_ORDER = ['none', 'low', 'medium', 'high'];
const PRODUCTIVITY_RESULT_ORDER = ['Not Started', 'In Progress', 'Completed'];

function productivityCellText(row, key) {
  switch (key) {
    case 'name': return row.name || 'Untitled';
    case 'category': return row.category || '—';
    case 'priority': return (row.priority && row.priority !== 'none') ? row.priority.charAt(0).toUpperCase() + row.priority.slice(1) : '—';
    case 'startDate': return row.startDate ? fmtShort(new Date(`${row.startDate}T00:00:00`).getTime()) : '—';
    case 'due': return row.due ? fmtShort(new Date(`${row.due}T00:00:00`).getTime()) : '—';
    case 'completedAt': return row.completedAt ? fmtDateTime(row.completedAt) : '—';
    case 'status': return `${itemDisplayProgress(row)}%`;
    case 'result': return productivityResultLabel(row);
    case 'delivery': return productivityDeliveryInfo(row).text;
    case 'score': { const s = productivityRowScore(row); return s === null ? '—' : String(s); }
    default: return '—';
  }
}

function productivityCellSortValue(row, key) {
  switch (key) {
    case 'name': return (row.name || '').toLowerCase();
    case 'category': return (row.category || '').toLowerCase();
    case 'priority': return PRODUCTIVITY_PRIORITY_ORDER.indexOf(row.priority || 'none');
    case 'startDate': return row.startDate || null;
    case 'due': return row.due || null;
    case 'completedAt': return row.completedAt || null;
    case 'status': return itemDisplayProgress(row);
    case 'result': return PRODUCTIVITY_RESULT_ORDER.indexOf(productivityResultLabel(row));
    case 'delivery': return productivityDeliveryInfo(row).diff;
    case 'score': return productivityRowScore(row);
    default: return null;
  }
}

function productivitySortRows(rows) {
  if (!productivitySortColumn) return rows;
  const key = productivitySortColumn;
  const dir = productivitySortDir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = productivityCellSortValue(a, key);
    const bv = productivityCellSortValue(b, key);
    const aEmpty = av === null || av === undefined || av === '';
    const bEmpty = bv === null || bv === undefined || bv === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function productivityRowPassesFilters(row) {
  return Object.entries(productivityColumnFilters).every(([key, allowed]) => {
    if (!allowed || !allowed.size) return true;
    return allowed.has(productivityCellText(row, key));
  });
}

function productivityAllCurrentRows() {
  return [
    ...buildProductivityTaskRows(productivityEmployee, productivityCategory, productivityFrom, productivityTo),
    ...buildProductivityProjectRows(productivityEmployee, productivityCategory, productivityFrom, productivityTo),
    ...buildProductivityRegularRows(productivityEmployee, productivityCategory, productivityFrom, productivityTo),
  ];
}

function productivityBuildCell(row, key) {
  const td = document.createElement('td');
  switch (key) {
    case 'name':
      td.className = 'productivity-task-name';
      td.textContent = row.name || 'Untitled';
      break;
    case 'category':
      td.textContent = row.category || '—';
      break;
    case 'priority':
      if (row.priority && row.priority !== 'none') {
        const pill = document.createElement('span');
        pill.className = `task-priority productivity-priority-pill ${row.priority}`;
        pill.textContent = row.priority.charAt(0).toUpperCase() + row.priority.slice(1);
        td.appendChild(pill);
      } else {
        td.textContent = '—';
      }
      break;
    case 'startDate':
      td.textContent = row.startDate ? fmtShort(new Date(`${row.startDate}T00:00:00`).getTime()) : '—';
      break;
    case 'due':
      td.textContent = row.due ? fmtShort(new Date(`${row.due}T00:00:00`).getTime()) : '—';
      break;
    case 'completedAt':
      td.textContent = row.completedAt ? fmtDateTime(row.completedAt) : '—';
      break;
    case 'status': {
      const pct = itemDisplayProgress(row);
      const pill = document.createElement('span');
      pill.className = `productivity-status-pill${pct >= 100 ? ' full' : pct > 0 ? ' partial' : ' empty'}`;
      pill.textContent = `${pct}%`;
      td.appendChild(pill);
      break;
    }
    case 'result': {
      const result = productivityResultLabel(row);
      const pill = document.createElement('span');
      pill.className = `productivity-result-pill result-${result.toLowerCase().replace(/\s+/g, '-')}`;
      pill.textContent = result;
      td.appendChild(pill);
      break;
    }
    case 'delivery': {
      const delivery = productivityDeliveryInfo(row);
      td.className = `productivity-delivery ${delivery.cls}`;
      td.textContent = delivery.text;
      break;
    }
    case 'score': {
      const score = productivityRowScore(row);
      const tier = productivityScoreTier(score);
      const pill = document.createElement('span');
      pill.className = `productivity-score-tier ${tier.cls}`;
      pill.title = tier.label;
      pill.textContent = score === null ? '—' : String(score);
      td.appendChild(pill);
      break;
    }
  }
  return td;
}

function openProductivityColumnMenu(anchorEl, columnKey) {
  document.querySelectorAll('.productivity-col-menu').forEach((m) => m.remove());

  const menu = document.createElement('div');
  menu.className = 'status-dropdown-popup productivity-col-menu';

  const sortAscBtn = document.createElement('button');
  sortAscBtn.type = 'button';
  sortAscBtn.className = 'status-opt';
  sortAscBtn.textContent = 'Sort ascending';
  sortAscBtn.addEventListener('click', () => {
    productivitySortColumn = columnKey;
    productivitySortDir = 'asc';
    menu.remove();
    render();
  });
  menu.appendChild(sortAscBtn);

  const sortDescBtn = document.createElement('button');
  sortDescBtn.type = 'button';
  sortDescBtn.className = 'status-opt';
  sortDescBtn.textContent = 'Sort descending';
  sortDescBtn.addEventListener('click', () => {
    productivitySortColumn = columnKey;
    productivitySortDir = 'desc';
    menu.remove();
    render();
  });
  menu.appendChild(sortDescBtn);

  if (productivitySortColumn === columnKey) {
    const clearSortBtn = document.createElement('button');
    clearSortBtn.type = 'button';
    clearSortBtn.className = 'status-opt';
    clearSortBtn.textContent = 'Clear sort';
    clearSortBtn.addEventListener('click', () => {
      productivitySortColumn = null;
      menu.remove();
      render();
    });
    menu.appendChild(clearSortBtn);
  }

  const divider = document.createElement('div');
  divider.className = 'productivity-col-menu-divider';
  menu.appendChild(divider);

  const filterLabel = document.createElement('div');
  filterLabel.className = 'productivity-col-menu-label';
  filterLabel.textContent = 'Filter';
  menu.appendChild(filterLabel);

  const uniqueValues = [...new Set(productivityAllCurrentRows().map((r) => productivityCellText(r, columnKey)))]
    .sort((a, b) => a.localeCompare(b));

  const activeFilter = productivityColumnFilters[columnKey];
  const checked = new Set(activeFilter && activeFilter.size ? [...activeFilter].filter((v) => uniqueValues.includes(v)) : uniqueValues);

  const listWrap = document.createElement('div');
  listWrap.className = 'productivity-col-menu-list';
  uniqueValues.forEach((val) => {
    const optRow = document.createElement('label');
    optRow.className = 'productivity-col-menu-checkrow';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked.has(val);
    cb.addEventListener('change', () => {
      if (cb.checked) checked.add(val); else checked.delete(val);
      applyBtn.disabled = checked.size === 0;
    });
    optRow.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = val;
    optRow.appendChild(span);
    listWrap.appendChild(optRow);
  });
  menu.appendChild(listWrap);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'productivity-col-menu-actions';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'link-btn';
  selectAllBtn.textContent = 'All';
  selectAllBtn.addEventListener('click', () => {
    uniqueValues.forEach((v) => checked.add(v));
    listWrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
    applyBtn.disabled = false;
  });
  actionsRow.appendChild(selectAllBtn);

  const clearAllBtn = document.createElement('button');
  clearAllBtn.type = 'button';
  clearAllBtn.className = 'link-btn';
  clearAllBtn.textContent = 'None';
  clearAllBtn.addEventListener('click', () => {
    checked.clear();
    listWrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
    applyBtn.disabled = true;
  });
  actionsRow.appendChild(clearAllBtn);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn small';
  applyBtn.textContent = 'Apply';
  applyBtn.disabled = checked.size === 0;
  applyBtn.addEventListener('click', () => {
    if (checked.size >= uniqueValues.length) {
      delete productivityColumnFilters[columnKey];
    } else {
      productivityColumnFilters[columnKey] = new Set(checked);
    }
    menu.remove();
    render();
  });
  actionsRow.appendChild(applyBtn);

  menu.appendChild(actionsRow);

  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  menu.style.position = 'absolute';
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  if (rect.left + menuWidth > window.innerWidth - 12) {
    menu.style.left = `${rect.right + window.scrollX - menuWidth}px`;
  } else {
    menu.style.left = `${rect.left + window.scrollX}px`;
  }
  menu.style.zIndex = '1200';

  const closeMenu = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorEl) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('scroll', closeOnScroll, true);
    }
  };
  const closeOnScroll = () => {
    menu.remove();
    document.removeEventListener('click', closeMenu);
    document.removeEventListener('scroll', closeOnScroll, true);
  };
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('scroll', closeOnScroll, true);
  }, 0);
}

function productivityBuildHeaderRow() {
  const tr = document.createElement('tr');
  PRODUCTIVITY_COLUMNS.forEach(({ key, label }) => {
    const th = document.createElement('th');
    const headWrap = document.createElement('div');
    headWrap.className = 'productivity-th-wrap';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    headWrap.appendChild(labelSpan);

    if (productivitySortColumn === key) {
      const arrow = document.createElement('span');
      arrow.className = 'productivity-sort-arrow';
      arrow.textContent = productivitySortDir === 'desc' ? '↓' : '↑';
      headWrap.appendChild(arrow);
    }

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    const hasFilter = Boolean(productivityColumnFilters[key] && productivityColumnFilters[key].size);
    menuBtn.className = `productivity-th-menu-btn${hasFilter ? ' active' : ''}`;
    menuBtn.innerHTML = '&#8942;';
    menuBtn.title = 'Sort / filter this column';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openProductivityColumnMenu(menuBtn, key);
    });
    headWrap.appendChild(menuBtn);

    th.appendChild(headWrap);
    tr.appendChild(th);
  });
  return tr;
}

function renderProductivityUnifiedTable(sections) {
  const section = document.createElement('div');
  section.className = 'productivity-table-section';

  const heading = document.createElement('h3');
  heading.className = 'productivity-summary-heading';
  heading.textContent = 'Report';
  section.appendChild(heading);

  const panel = document.createElement('div');
  panel.className = 'table-panel productivity-table-panel';

  const table = document.createElement('table');
  table.className = 'task-table productivity-table';

  const thead = document.createElement('thead');
  thead.appendChild(productivityBuildHeaderRow());
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  sections.forEach(({ label, rows }) => {
    const filtered = productivitySortRows(rows.filter(productivityRowPassesFilters));

    const groupRow = document.createElement('tr');
    groupRow.className = 'productivity-section-row';
    const groupTd = document.createElement('td');
    groupTd.colSpan = PRODUCTIVITY_COLUMNS.length;
    groupTd.textContent = `${label} (${filtered.length})`;
    groupRow.appendChild(groupTd);
    tbody.appendChild(groupRow);

    if (!filtered.length) {
      const emptyRow = document.createElement('tr');
      const emptyTd = document.createElement('td');
      emptyTd.colSpan = PRODUCTIVITY_COLUMNS.length;
      emptyTd.className = 'productivity-empty-row';
      emptyTd.textContent = 'No rows match the current filters.';
      emptyRow.appendChild(emptyTd);
      tbody.appendChild(emptyRow);
      return;
    }

    filtered.forEach((row) => {
      const tr = document.createElement('tr');
      PRODUCTIVITY_COLUMNS.forEach(({ key }) => tr.appendChild(productivityBuildCell(row, key)));
      tbody.appendChild(tr);
    });
  });
  table.appendChild(tbody);
  panel.appendChild(table);
  section.appendChild(panel);
  return section;
}

// A real .xlsx would need an external library (this app has no build
// step/bundler by design -- window.print() is used for PDF export for the
// same reason). CSV opens directly in Excel with full column structure and
// needs nothing but the browser, so that's what "Download Excel" produces.
function csvEscapeCell(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function downloadProductivityCsv() {
  if (!productivityEmployee || !productivityFrom || !productivityTo || productivityFrom > productivityTo) return;

  const sections = [
    { label: 'Tasks', rows: buildProductivityTaskRows(productivityEmployee, productivityCategory, productivityFrom, productivityTo) },
    { label: 'Projects', rows: buildProductivityProjectRows(productivityEmployee, productivityCategory, productivityFrom, productivityTo) },
    { label: 'Regular Tasks', rows: buildProductivityRegularRows(productivityEmployee, productivityCategory, productivityFrom, productivityTo) },
  ];

  // Matches exactly what's currently on screen -- same active column
  // sort/filters as the Report table, just flattened into one sheet with
  // a Section column instead of the table's divider rows (a real column
  // is what makes it filterable/pivotable once it's actually in Excel).
  const header = ['Section', ...PRODUCTIVITY_COLUMNS.map((c) => c.label)];
  const lines = [header.map(csvEscapeCell).join(',')];

  sections.forEach(({ label, rows }) => {
    const filtered = productivitySortRows(rows.filter(productivityRowPassesFilters));
    filtered.forEach((row) => {
      const cells = [label, ...PRODUCTIVITY_COLUMNS.map(({ key }) => productivityCellText(row, key))];
      lines.push(cells.map(csvEscapeCell).join(','));
    });
  });

  // Leading BOM so Excel (unlike most other CSV consumers) correctly
  // detects UTF-8 instead of mis-rendering any non-ASCII characters.
  const csv = `﻿${lines.join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const employeeLabel = productivityEmployee === PRODUCTIVITY_ALL_EMPLOYEES ? 'All-employees' : productivityEmployee.replace(/\s+/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `Report_${employeeLabel}_${productivityFrom}_to_${productivityTo}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function productivityDateRangeArray(from, to) {
  const fromDate = new Date(`${from}T00:00:00`);
  const toDate = new Date(`${to}T00:00:00`);
  const days = Math.max(0, Math.round((toDate - fromDate) / 86400000)) + 1;
  return Array.from({ length: days }, (_, i) => addDays(fromDate, i));
}

function buildProductivitySummary(employee, category, from, to) {
  const matchesCategory = (item) => !category || item.category === category;

  const tasks = state.lists.flatMap((list) => list.tasks)
    .filter((t) => productivityMatchesEmployee(employee, t.assignedTo) && matchesCategory(t) && productivityInRange(t, from, to));
  const taskStats = { done: tasks.filter((t) => t.done).length, total: tasks.length };

  const projects = (state.projects || [])
    .filter((p) => !p.archived && !p.deleted && productivityMatchesAnyEmployee(employee, p.owners) && matchesCategory(p) && productivityInRange(p, from, to));
  const projectStats = { done: projects.filter((p) => p.done).length, total: projects.length };

  const dates = productivityDateRangeArray(from, to);
  const regularTasks = (state.regular?.tasks || []).filter((t) => productivityMatchesEmployee(employee, t.owner) && matchesCategory(t));
  const regularStats = regularTasks.reduce((acc, task) => {
    const p = regularTaskProgress(task, dates);
    acc.done += p.done;
    acc.total += p.total;
    return acc;
  }, { done: 0, total: 0 });

  return [
    { label: 'Tasks', ...taskStats },
    { label: 'Projects', ...projectStats },
    { label: 'Regular Tasks', ...regularStats },
  ];
}

// ---------- Productivity report: performance score ----------
//
// A composite 0-100 score built from 4 independently-normalized components
// (Completion, Timeliness, Priority Handling, Waste), combined as a weighted
// average -- see the in-app discussion this was designed from. Any component
// that has no applicable data for the current filters (e.g. no high-priority
// tasks in range) is excluded rather than defaulted to 0/100, and the
// remaining weights are rebalanced so the composite never gets unfairly
// dragged down by "not applicable" data.

const PRODUCTIVITY_SCORE_WEIGHTS = { completion: 0.30, timeliness: 0.30, priorityHandling: 0.25, waste: 0.15 };

function productivityClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Low=1, Medium=2, High=3 -- everything else (regular tasks carry no
// priority field, so do occurrences) falls back to the Low baseline rather
// than being weightless.
function priorityWeight(priority) {
  if (priority === 'high') return 3;
  if (priority === 'medium') return 2;
  return 1;
}

function productivityRowWeight(row) {
  return priorityWeight(row.priority);
}

// Total priority-weighted workload assigned in the period -- used both for
// the Completion rate's denominator and to compare one employee's workload
// against the team average (see applyVolumeAdjustment).
function productivityTotalWeight(taskRows, projectRows, regularRows) {
  let total = 0;
  [...taskRows, ...projectRows].forEach((r) => { total += productivityRowWeight(r); });
  regularRows.forEach((r) => { total += (r.occurrences && r.occurrences.total) || 0; });
  return total;
}

function computeProductivityCompletion(taskRows, projectRows, regularRows) {
  let doneWeight = 0;
  let totalWeight = 0;
  let doneCount = 0;
  let totalCount = 0;
  [...taskRows, ...projectRows].forEach((r) => {
    const w = productivityRowWeight(r);
    totalWeight += w;
    totalCount += 1;
    if (r.done) { doneWeight += w; doneCount += 1; }
  });
  regularRows.forEach((r) => {
    const occ = r.occurrences || { done: 0, total: 0 };
    totalWeight += occ.total;
    doneWeight += occ.done;
    totalCount += occ.total;
    doneCount += occ.done;
  });
  if (totalWeight === 0) return { score: null, doneCount, totalCount };
  return { score: Math.round((doneWeight / totalWeight) * 100), doneCount, totalCount };
}

// Bounded volume adjustment: an employee carrying an above-average
// weighted workload gets a modest boost, below-average gets a modest
// discount -- capped so raw volume alone can never dominate the score
// (this is what stops "gets fewer tasks, finishes them all" from
// automatically outscoring someone doing real above-average output).
function applyVolumeAdjustment(rawScore, employeeWeight, teamAvgWeight) {
  if (rawScore === null || !teamAvgWeight) return rawScore;
  const ratio = employeeWeight / teamAvgWeight;
  const multiplier = productivityClamp(Math.sqrt(ratio || 0), 0.85, 1.15);
  return Math.round(productivityClamp(rawScore * multiplier, 0, 100));
}

function productivityTeamAverageWeight(category, from, to) {
  const employees = getAllEmployees();
  if (!employees.length) return 0;
  const totals = employees.map((name) => productivityTotalWeight(
    buildProductivityTaskRows(name, category, from, to),
    buildProductivityProjectRows(name, category, from, to),
    buildProductivityRegularRows(name, category, from, to),
  ));
  return totals.reduce((s, v) => s + v, 0) / employees.length;
}

// due/completedAt delta -> 0-100. On-time = 50 (neutral baseline). Early
// credit maxes out at E_MAX days (further-early adds nothing, so marking
// things done implausibly early doesn't inflate the score). Late loses
// credit down to 0 at L_MAX days.
const PRODUCTIVITY_TIMELINESS_EARLY_CAP_DAYS = 5;
const PRODUCTIVITY_TIMELINESS_LATE_CAP_DAYS = 7;

function timelinessScoreForDiff(diffDays) {
  if (diffDays <= 0) {
    const earlyDays = -diffDays;
    return productivityClamp(50 + 50 * (earlyDays / PRODUCTIVITY_TIMELINESS_EARLY_CAP_DAYS), 0, 100);
  }
  return productivityClamp(50 - 50 * (diffDays / PRODUCTIVITY_TIMELINESS_LATE_CAP_DAYS), 0, 100);
}

// Scores both completed tasks (against their actual delivery delta) AND
// still-open overdue tasks (against days-overdue-so-far, capped at the
// same late floor) -- otherwise an employee could simply never finish a
// late task and it would never count against them.
function computeProductivityTimeliness(taskRows, projectRows) {
  const today = todayStr();
  let weightedScore = 0;
  let weightSum = 0;
  let onTime = 0;
  let late = 0;
  let early = 0;
  const deltas = [];

  [...taskRows, ...projectRows].forEach((r) => {
    const w = productivityRowWeight(r);
    if (r.done && r.due && r.completedAt) {
      const diff = productivityDeliveryInfo(r).diff;
      if (diff === null) return;
      weightedScore += w * timelinessScoreForDiff(diff);
      weightSum += w;
      deltas.push(-diff);
      if (diff === 0) onTime += 1; else if (diff > 0) late += 1; else early += 1;
    } else if (!r.done && r.due && r.due < today) {
      const daysOverdue = productivityDateStrDiffDays(today, r.due);
      weightedScore += w * timelinessScoreForDiff(daysOverdue);
      weightSum += w;
      late += 1;
    }
  });

  if (weightSum === 0) return { score: null, onTime, late, early, avgDeltaDays: null };
  const avgDeltaDays = deltas.length ? Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10 : null;
  return { score: Math.round(weightedScore / weightSum), onTime, late, early, avgDeltaDays };
}

// Rather than guess at "was this task paused because a more urgent one
// landed on top of it" (which today's data can't actually prove), this
// measures the thing we can prove directly: how well High-priority work
// specifically gets delivered. Tasks/projects have a due date, so they
// contribute an on-time-delivery score; regular (recurring) tasks have no
// due date, so they contribute their occurrence completion rate instead --
// both blended (weighted by item count) into one score, so every
// high-priority item counted in doneCount/totalCount also actually
// affects the score, not just the due-dated subset.
function computeProductivityPriorityHandling(taskRows, projectRows, regularRows) {
  const highTasks = taskRows.filter((r) => r.priority === 'high');
  const highProjects = projectRows.filter((r) => r.priority === 'high');
  const highRegular = (regularRows || []).filter((r) => r.priority === 'high');
  const all = [...highTasks, ...highProjects, ...highRegular];
  if (!all.length) return { score: null, doneCount: 0, totalCount: 0 };

  const doneCount = highTasks.filter((r) => r.done).length
    + highProjects.filter((r) => r.done).length
    + highRegular.filter((r) => r.done).length;

  const timeliness = computeProductivityTimeliness(highTasks, highProjects);
  const regularRates = highRegular
    .map((r) => (r.occurrences && r.occurrences.total > 0 ? (r.occurrences.done / r.occurrences.total) * 100 : null))
    .filter((v) => v !== null);

  let score = timeliness.score;
  if (regularRates.length) {
    const regularAvg = regularRates.reduce((s, v) => s + v, 0) / regularRates.length;
    const dueCount = highTasks.length + highProjects.length;
    score = score === null
      ? Math.round(regularAvg)
      : Math.round((score * dueCount + regularAvg * regularRates.length) / (dueCount + regularRates.length));
  }

  return { score, doneCount, totalCount: all.length };
}

// Only counts deletions explicitly tagged "abandoned" via the Deleted
// list's reason picker (renderDeleteReasonPicker) -- "no longer needed"
// and untagged entries are excluded entirely rather than guessed at, so
// this reflects real signal instead of an assumption. A task/project only
// ever gets a reason prompt in the first place if it had progress > 0 when
// deleted, so 0%-progress deletions were never in the running anyway.
function buildProductivityWasteItems(employee, category, from, to) {
  const matchesCategory = (item) => !category || item.category === category;
  const fromTs = new Date(`${from}T00:00:00`).getTime();
  const toTs = new Date(`${to}T23:59:59`).getTime();
  const items = [];

  state.lists.forEach((list) => {
    (list.deletedTasks || []).forEach((entry) => {
      const t = entry.task;
      if (!t || !entry.deletedAt) return;
      if (entry.reason !== 'abandoned') return;
      if (entry.deletedAt < fromTs || entry.deletedAt > toTs) return;
      if (!productivityMatchesEmployee(employee, t.assignedTo)) return;
      if (!matchesCategory(t)) return;
      items.push({ priority: t.priority, progress: itemDisplayProgress(t) });
    });
  });

  (state.projects || []).forEach((p) => {
    if (!p.deleted || !p.deletedAt) return;
    if (p.deleteReason !== 'abandoned') return;
    if (p.deletedAt < fromTs || p.deletedAt > toTs) return;
    if (!productivityMatchesAnyEmployee(employee, p.owners)) return;
    if (!matchesCategory(p)) return;
    items.push({ priority: p.priority, progress: itemDisplayProgress(p) });
  });

  return items;
}

function computeProductivityWaste(wasteItems, assignedTotalWeight) {
  if (!wasteItems.length) return { score: assignedTotalWeight > 0 ? 0 : null, count: 0 };
  const wastedWeight = wasteItems.reduce((s, it) => s + productivityRowWeight(it) * (it.progress / 100), 0);
  const itemsWeight = wasteItems.reduce((s, it) => s + productivityRowWeight(it), 0);
  const denom = assignedTotalWeight + itemsWeight;
  const score = denom > 0 ? Math.round((wastedWeight / denom) * 100) : null;
  return { score, count: wasteItems.length };
}

function productivityScoreTier(score) {
  if (score === null || score === undefined) return { label: 'No data', cls: 'na' };
  if (score >= 85) return { label: 'Excellent', cls: 'excellent' };
  if (score >= 70) return { label: 'Good', cls: 'good' };
  if (score >= 50) return { label: 'Needs focus', cls: 'needs-focus' };
  return { label: 'At risk', cls: 'at-risk' };
}

function computeProductivityScorecard(employee, category, from, to) {
  const taskRows = buildProductivityTaskRows(employee, category, from, to);
  const projectRows = buildProductivityProjectRows(employee, category, from, to);
  const regularRows = buildProductivityRegularRows(employee, category, from, to);

  const completion = computeProductivityCompletion(taskRows, projectRows, regularRows);
  if (completion.score !== null && employee !== PRODUCTIVITY_ALL_EMPLOYEES) {
    const employeeWeight = productivityTotalWeight(taskRows, projectRows, regularRows);
    const teamAvgWeight = productivityTeamAverageWeight(category, from, to);
    completion.score = applyVolumeAdjustment(completion.score, employeeWeight, teamAvgWeight);
  }

  const timeliness = computeProductivityTimeliness(taskRows, projectRows);
  const priorityHandling = computeProductivityPriorityHandling(taskRows, projectRows, regularRows);

  const wasteItems = buildProductivityWasteItems(employee, category, from, to);
  const assignedTotalWeight = productivityTotalWeight(taskRows, projectRows, regularRows);
  const waste = computeProductivityWaste(wasteItems, assignedTotalWeight);

  const parts = [
    { key: 'completion', score: completion.score, weight: PRODUCTIVITY_SCORE_WEIGHTS.completion },
    { key: 'timeliness', score: timeliness.score, weight: PRODUCTIVITY_SCORE_WEIGHTS.timeliness },
    { key: 'priorityHandling', score: priorityHandling.score, weight: PRODUCTIVITY_SCORE_WEIGHTS.priorityHandling },
    { key: 'waste', score: waste.score === null ? null : (100 - waste.score), weight: PRODUCTIVITY_SCORE_WEIGHTS.waste },
  ];
  const available = parts.filter((p) => typeof p.score === 'number' && !Number.isNaN(p.score));
  const weightSum = available.reduce((s, p) => s + p.weight, 0);
  const compositeScore = weightSum > 0
    ? Math.round(available.reduce((s, p) => s + p.score * (p.weight / weightSum), 0))
    : null;

  return {
    completion,
    timeliness,
    priorityHandling,
    waste,
    composite: { score: compositeScore, tier: productivityScoreTier(compositeScore), contributingCount: available.length },
  };
}

const PRODUCTIVITY_SCORE_CARD_META = [
  { key: 'completion', label: 'Completion Score', color: '#1E9E6B', icon: '<path d="M4 10.5l3.5 3.5L16 5.5"/>' },
  { key: 'timeliness', label: 'Timeliness Score', color: '#2F80ED', icon: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>' },
  { key: 'priorityHandling', label: 'Priority Handling', color: '#E68A00', icon: '<path d="M10 3l1.8 4.6L16 9l-4.2 1.4L10 15l-1.8-4.6L4 9l4.2-1.4z"/>' },
  { key: 'waste', label: 'Waste Score', color: '#E04858', icon: '<circle cx="10" cy="10" r="7"/><path d="M10 6v5M10 14v.01"/>' },
  { key: 'composite', label: 'Final Composite Score', color: '#7C4DBD', icon: '<path d="M10 3l2 4 4.4.6-3.2 3 .8 4.4L10 13l-4 2 .8-4.4-3.2-3L8 7z"/>' },
];

function productivityGaugeSvg(pct, color) {
  const p = pct === null || pct === undefined ? null : productivityClamp(pct, 0, 100);
  const r = 30;
  const c = 2 * Math.PI * r;
  const dash = p === null ? 0 : (p / 100) * c;
  return `
    <svg viewBox="0 0 72 72" width="72" height="72" class="productivity-gauge" aria-hidden="true">
      <circle cx="36" cy="36" r="${r}" fill="none" stroke="rgba(17,24,39,0.08)" stroke-width="7"/>
      <circle cx="36" cy="36" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 36 36)"/>
      <text x="36" y="41" text-anchor="middle" class="productivity-gauge-text">${p === null ? '—' : p}</text>
    </svg>`;
}

function productivityScoreStatLines(key, data) {
  switch (key) {
    case 'completion':
      return [`Items completed: ${data.completion.doneCount} of ${data.completion.totalCount}`];
    case 'timeliness':
      return [
        `On time or early: ${data.timeliness.onTime + data.timeliness.early}`,
        `Late: ${data.timeliness.late}`,
        data.timeliness.avgDeltaDays === null ? null
          : data.timeliness.avgDeltaDays >= 0 ? `Avg ${data.timeliness.avgDeltaDays} days early`
          : `Avg ${Math.abs(data.timeliness.avgDeltaDays)} days late`,
      ].filter(Boolean);
    case 'priorityHandling':
      return data.priorityHandling.totalCount
        ? [`High-priority completed: ${data.priorityHandling.doneCount} of ${data.priorityHandling.totalCount}`]
        : ['No high-priority items in this range'];
    case 'waste':
      return [
        data.waste.score === null ? 'No assigned work in this range' : `${data.waste.score}% of weighted effort wasted (lower is better)`,
        `Tagged "Abandoned": ${data.waste.count}`,
        'Untagged / "No longer needed" deletions don’t count',
      ];
    case 'composite':
      return [`Based on ${data.composite.contributingCount} of 4 components`];
    default:
      return [];
  }
}

function renderProductivityScorecard(data) {
  const wrap = document.createElement('div');
  wrap.className = 'productivity-scorecard';

  PRODUCTIVITY_SCORE_CARD_META.forEach(({ key, label, color, icon }) => {
    const info = key === 'composite' ? data.composite : data[key];
    // Waste is the one card where the raw number is "bad when high" (kept
    // as-is on screen, same as the reference mockup, with an explicit
    // "lower is better" note) -- but it's still tiered/classified off its
    // inverted (cleanliness) value so "12% waste" correctly reads as an
    // Excellent tier rather than a bad one.
    const score = info.score;
    const tier = key === 'composite' ? data.composite.tier
      : key === 'waste' ? productivityScoreTier(score === null ? null : 100 - score)
      : productivityScoreTier(score);

    const card = document.createElement('div');
    card.className = `productivity-score-card ${key}`;

    const head = document.createElement('div');
    head.className = 'productivity-score-card-head';
    head.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon}</svg><span>${escapeHtml(label)}</span>`;
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'productivity-score-card-body';
    body.innerHTML = productivityGaugeSvg(score, color);
    const tierEl = document.createElement('div');
    tierEl.className = `productivity-score-tier ${tier.cls}`;
    tierEl.textContent = tier.label;
    body.appendChild(tierEl);
    card.appendChild(body);

    const stats = document.createElement('div');
    stats.className = 'productivity-score-stats';
    productivityScoreStatLines(key, data).forEach((line) => {
      const p = document.createElement('div');
      p.textContent = line;
      stats.appendChild(p);
    });
    card.appendChild(stats);

    wrap.appendChild(card);
  });

  return wrap;
}

function renderProductivitySummary(summary) {
  const wrap = document.createElement('div');
  wrap.className = 'productivity-summary';

  const heading = document.createElement('h3');
  heading.className = 'productivity-summary-heading';
  heading.textContent = 'Completion summary';
  wrap.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'productivity-summary-grid';
  summary.forEach(({ label, done, total }) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const card = document.createElement('div');
    card.className = 'productivity-summary-card';
    card.innerHTML = `
      <div class="productivity-summary-label">${escapeHtml(label)}</div>
      <div class="productivity-summary-pct">${pct}%</div>
      <div class="productivity-summary-frac">${done}/${total} completed</div>
      <div class="productivity-summary-bar"><div class="productivity-summary-bar-fill" style="width:${pct}%"></div></div>
    `;
    grid.appendChild(card);
  });
  wrap.appendChild(grid);

  return wrap;
}

function openScoringAlgorithmInfoPopup() {
  document.querySelectorAll('.regular-popup-overlay').forEach((m) => m.remove());

  const overlay = document.createElement('div');
  overlay.className = 'regular-popup-overlay';

  const popup = document.createElement('div');
  popup.style.maxWidth = '560px';
  popup.style.maxHeight = '80vh';
  popup.style.overflowY = 'auto';

  const heading = document.createElement('h2');
  heading.style.cssText = 'margin:0 0 4px 0;font-size:17px;font-weight:600;';
  heading.textContent = 'How the score is calculated';
  popup.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'productivity-info-body';
  body.innerHTML = `
    <p>Every task/project row gets a <strong>Score (0-100)</strong> using the same three ingredients everywhere: how important it was, whether it was actually finished, and whether it was finished on time.</p>

    <h3>Priority weight</h3>
    <p>Low = 1, Medium = 2, High = 3. A finished High-priority task always counts for 3x as much as a finished Low-priority one, in every calculation below.</p>

    <h3>Per-row Score (the new column)</h3>
    <ul>
      <li><strong>Done, with a due date:</strong> scored on how early/late it was finished -- on time is the baseline, earlier scores higher (capped, so being wildly early doesn't inflate it), later scores lower (floors out once it's a week+ late).</li>
      <li><strong>Not done yet, not overdue:</strong> scored on progress made so far.</li>
      <li><strong>Not done and overdue:</strong> scored low, and gets lower the longer it's been overdue.</li>
      <li><strong>Regular (recurring) tasks:</strong> scored on the completion rate across every occurrence expected in the selected date range.</li>
    </ul>

    <h3>Completion Score</h3>
    <p>Priority-weighted completion rate (weighted "done" ÷ weighted "assigned"), then nudged up to ±15% based on whether this person's total workload is above or below the team average for the same period -- so completing fewer tasks because fewer were assigned isn't scored the same as completing fewer out of a normal load.</p>

    <h3>Timeliness Score</h3>
    <p>The priority-weighted average of every row's on-time/late outcome -- including tasks that are <em>still open and overdue right now</em>, not just ones already marked done, so nothing escapes scoring just by never being finished.</p>

    <h3>Priority Handling</h3>
    <p>The same idea as Timeliness, but only for High-priority items -- how well the work that mattered most actually got delivered.</p>

    <h3>Waste Score</h3>
    <p>Only counts tasks/projects explicitly tagged <strong>"Abandoned"</strong> when deleted (from the Deleted list's "Why?" picker) -- weighted by how much progress had already been made on them. Untagged or "No longer needed" deletions never count; nothing is guessed.</p>

    <h3>Final Composite Score</h3>
    <p>A weighted blend of the four scores above: Completion 30%, Timeliness 30%, Priority Handling 25%, Waste 15%. If a component has no data for the selected range (e.g. no High-priority items to judge), it's left out and the rest re-share its weight -- a missing component is never silently treated as a zero.</p>
  `;
  popup.appendChild(body);

  const closeRow = document.createElement('div');
  closeRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:14px;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'padding:8px 20px;border:1px solid #ddd;border-radius:999px;background:white;cursor:pointer;font-size:13.5px;font-weight:500;';
  closeBtn.addEventListener('click', () => overlay.remove());
  closeRow.appendChild(closeBtn);
  popup.appendChild(closeRow);

  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// "Previous month" is a discrete, complete calendar month (1st to last
// day of last month). The others are trailing windows ending today --
// the more common reading of "current/previous N months" in a report
// filter, and consistent with each other.
function applyProductivityDatePreset(preset) {
  const today = new Date();
  let from;
  let to;
  if (preset === 'current') {
    from = firstDayOfMonth(today);
    to = today;
  } else if (preset === 'prevMonth') {
    to = new Date(today.getFullYear(), today.getMonth(), 0);
    from = firstDayOfMonth(to);
  } else if (preset === 'prev3') {
    from = firstDayOfMonth(addMonths(today, -3));
    to = today;
  } else if (preset === 'prev6') {
    from = firstDayOfMonth(addMonths(today, -6));
    to = today;
  } else if (preset === 'prev12') {
    from = firstDayOfMonth(addMonths(today, -12));
    to = today;
  } else {
    return;
  }
  productivityFrom = dateKey(from);
  productivityTo = dateKey(to);
  productivityColumnFilters = {};
  productivitySortColumn = null;
  render();
}

function renderProductivityWorkspace() {
  const wrap = document.createElement('div');
  wrap.className = 'productivity-workspace';

  const filters = document.createElement('div');
  filters.className = 'productivity-filters';

  const empField = document.createElement('div');
  empField.className = 'productivity-field';
  empField.innerHTML = '<label>Employee</label>';
  const empSelect = document.createElement('select');
  const employeeNames = getAllEmployees();
  empSelect.innerHTML = `<option value="">Select employee…</option><option value="${PRODUCTIVITY_ALL_EMPLOYEES}"${productivityEmployee === PRODUCTIVITY_ALL_EMPLOYEES ? ' selected' : ''}>All employees</option>${employeeNames.map((name) => `<option value="${escapeHtml(name)}"${name === productivityEmployee ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}`;
  empSelect.addEventListener('change', () => { productivityEmployee = empSelect.value; productivityColumnFilters = {}; productivitySortColumn = null; render(); });
  empField.appendChild(empSelect);
  filters.appendChild(empField);

  const catField = document.createElement('div');
  catField.className = 'productivity-field';
  catField.innerHTML = '<label>Category</label>';
  const catSelect = document.createElement('select');
  const categories = state.categories || [];
  catSelect.innerHTML = `<option value="">All categories</option>${categories.map((c) => `<option value="${escapeHtml(c)}"${c === productivityCategory ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}`;
  catSelect.addEventListener('change', () => { productivityCategory = catSelect.value; productivityColumnFilters = {}; productivitySortColumn = null; render(); });
  catField.appendChild(catSelect);
  filters.appendChild(catField);

  const fromField = document.createElement('div');
  fromField.className = 'productivity-field';
  fromField.innerHTML = '<label>From</label>';
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.value = productivityFrom;
  fromInput.addEventListener('change', () => { productivityFrom = fromInput.value; productivityColumnFilters = {}; productivitySortColumn = null; render(); });
  fromField.appendChild(fromInput);
  filters.appendChild(fromField);

  const toField = document.createElement('div');
  toField.className = 'productivity-field';
  toField.innerHTML = '<label>To</label>';
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.value = productivityTo;
  toInput.addEventListener('change', () => { productivityTo = toInput.value; productivityColumnFilters = {}; productivitySortColumn = null; render(); });
  toField.appendChild(toInput);
  filters.appendChild(toField);

  wrap.appendChild(filters);

  // Quick-fill buttons -- the From/To inputs stay the actual source of
  // truth (still freely editable), these just prefill them instead of
  // requiring two manual date picks for a common range every time.
  const presetRow = document.createElement('div');
  presetRow.className = 'productivity-date-presets';
  [
    ['current', 'Current month'],
    ['prevMonth', 'Previous month'],
    ['prev3', 'Previous 3 months'],
    ['prev6', 'Previous 6 months'],
    ['prev12', 'Previous 12 months'],
  ].forEach(([key, label]) => {
    const presetBtn = document.createElement('button');
    presetBtn.type = 'button';
    presetBtn.className = 'productivity-preset-btn';
    presetBtn.textContent = label;
    presetBtn.addEventListener('click', () => applyProductivityDatePreset(key));
    presetRow.appendChild(presetBtn);
  });
  wrap.appendChild(presetRow);

  // Lives in the viewbar (top of the page, next to the "Productivity"
  // title) rather than inline with the filters below -- same spot
  // "Archived / + Add" occupies for the main task board and
  // "+ Add Website" occupies for Tabs.
  const ready = Boolean(productivityEmployee && productivityFrom && productivityTo && productivityFrom <= productivityTo);
  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'tab-add productivity-download-btn';
  downloadBtn.disabled = !ready;
  downloadBtn.title = ready ? 'Download this report as a PDF' : 'Choose an employee and a date range first';
  downloadBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Download PDF</span>';
  downloadBtn.addEventListener('click', () => window.print());

  const downloadExcelBtn = document.createElement('button');
  downloadExcelBtn.type = 'button';
  downloadExcelBtn.className = 'tab-add productivity-download-btn';
  downloadExcelBtn.disabled = !ready;
  downloadExcelBtn.title = ready ? 'Download this report as an Excel-compatible spreadsheet' : 'Choose an employee and a date range first';
  downloadExcelBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 3v18M16 3v18M3 9h18M3 15h18"/></svg><span>Download Excel</span>';
  downloadExcelBtn.addEventListener('click', () => downloadProductivityCsv());

  const infoBtn = document.createElement('button');
  infoBtn.type = 'button';
  infoBtn.className = 'productivity-info-btn';
  infoBtn.title = 'How is this score calculated?';
  infoBtn.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><line x1="10" y1="9" x2="10" y2="14"/><circle cx="10" cy="6.3" r="0.9" fill="currentColor" stroke="none"/></svg>';
  infoBtn.addEventListener('click', () => openScoringAlgorithmInfoPopup());

  productivityViewActionsEl.innerHTML = '';
  productivityViewActionsEl.appendChild(infoBtn);
  productivityViewActionsEl.appendChild(downloadBtn);
  productivityViewActionsEl.appendChild(downloadExcelBtn);

  // .viewbar (and these buttons inside it) is hidden entirely on mobile,
  // same as "+ Add Website" is for Tabs -- duplicate them into the
  // workspace content itself so the mobile Reports tab has full parity
  // with desktop instead of losing them outright.
  const mobileActions = document.createElement('div');
  mobileActions.className = 'productivity-mobile-actions';
  const mobileInfoBtn = infoBtn.cloneNode(true);
  mobileInfoBtn.addEventListener('click', () => openScoringAlgorithmInfoPopup());
  const mobilePdfBtn = downloadBtn.cloneNode(true);
  mobilePdfBtn.addEventListener('click', () => window.print());
  const mobileExcelBtn = downloadExcelBtn.cloneNode(true);
  mobileExcelBtn.addEventListener('click', () => downloadProductivityCsv());
  mobileActions.appendChild(mobileInfoBtn);
  mobileActions.appendChild(mobilePdfBtn);
  mobileActions.appendChild(mobileExcelBtn);
  wrap.appendChild(mobileActions);

  if (!productivityEmployee || !productivityFrom || !productivityTo) {
    wrap.appendChild(renderEmptyState('Choose an employee and a date range to see their performance report.'));
    return wrap;
  }

  if (productivityFrom > productivityTo) {
    wrap.appendChild(renderEmptyState('The "From" date is after the "To" date — please fix the range.'));
    return wrap;
  }

  // Print-only summary of the active filters -- the interactive
  // dropdowns/date inputs above are hidden in the print stylesheet
  // (form controls don't print meaningfully), so this plain-text line
  // is what actually identifies the report in the PDF/printout.
  const printHeader = document.createElement('div');
  printHeader.className = 'productivity-print-header';
  const rangeText = `${fmtShort(new Date(`${productivityFrom}T00:00:00`).getTime())} – ${fmtShort(new Date(`${productivityTo}T00:00:00`).getTime())}, ${productivityFrom.slice(0, 4)}`;
  const employeeLabel = productivityEmployee === PRODUCTIVITY_ALL_EMPLOYEES ? 'All employees' : productivityEmployee;
  printHeader.innerHTML = `
    <h2>Performance Report</h2>
    <p><strong>Employee:</strong> ${escapeHtml(employeeLabel)} &nbsp;·&nbsp; <strong>Category:</strong> ${escapeHtml(productivityCategory || 'All')} &nbsp;·&nbsp; <strong>Range:</strong> ${rangeText}</p>
  `;
  wrap.appendChild(printHeader);

  const scorecard = computeProductivityScorecard(productivityEmployee, productivityCategory, productivityFrom, productivityTo);
  wrap.appendChild(renderProductivityScorecard(scorecard));

  const taskRows = buildProductivityTaskRows(productivityEmployee, productivityCategory, productivityFrom, productivityTo);
  const projectRows = buildProductivityProjectRows(productivityEmployee, productivityCategory, productivityFrom, productivityTo);
  const regularRows = buildProductivityRegularRows(productivityEmployee, productivityCategory, productivityFrom, productivityTo);
  wrap.appendChild(renderProductivityUnifiedTable([
    { label: 'Tasks', rows: taskRows },
    { label: 'Projects', rows: projectRows },
    { label: 'Regular Tasks', rows: regularRows },
  ]));

  const summary = buildProductivitySummary(productivityEmployee, productivityCategory, productivityFrom, productivityTo);
  wrap.appendChild(renderProductivitySummary(summary));

  return wrap;
}

function renderChartsWorkspace() {
  const wrap = document.createElement('div');
  wrap.className = 'charts-shell';

  const scopeLabel = activeRegularEmployee === 'all' ? 'All employees' : activeRegularEmployee;
  const employeeKey = activeRegularEmployee === 'all' ? 'all' : activeRegularEmployee;

  // --- Executive KPI Summary Cards ---
  const allMainTasks = (state.lists || []).flatMap((l) => l.sections ? l.sections.flatMap((s) => s.tasks || []) : (l.tasks || []));
  const projectTasks = (state.projects || []).flatMap((p) => p.tasks || []);
  const allTasks = [...allMainTasks, ...projectTasks];
  const completedTasksCount = allTasks.filter((t) => t.completed || t.status === 'done').length;
  const totalTasksCount = allTasks.length;
  const completionRatePct = totalTasksCount ? Math.round((completedTasksCount / totalTasksCount) * 100) : 0;

  const regularDates = getRegularDates();
  const regTasks = (state.regular?.tasks || []).filter((task) => activeRegularEmployee === 'all' || sameEmployee(task.owner, activeRegularEmployee));
  const regProgress = regTasks.reduce((acc, t) => {
    const p = regularTaskProgress(t, regularDates);
    acc.done += p.done;
    acc.total += p.total;
    return acc;
  }, { done: 0, total: 0 });
  const regEfficiencyPct = regProgress.total ? Math.round((regProgress.done / regProgress.total) * 100) : 0;
  const registeredEmpsCount = (state.employees || []).length;

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'analytics-kpi-grid';
  kpiGrid.innerHTML = `
    <div class="analytics-kpi-card accent-primary">
      <div class="kpi-icon-wrap">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      </div>
      <div class="kpi-info">
        <span class="kpi-label">Completion Rate</span>
        <div class="kpi-val-row">
          <span class="kpi-value">${completionRatePct}%</span>
          <span class="kpi-pill ${completionRatePct >= 50 ? 'success' : 'neutral'}">${completedTasksCount} / ${totalTasksCount} Done</span>
        </div>
      </div>
    </div>

    <div class="analytics-kpi-card accent-secondary">
      <div class="kpi-icon-wrap">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
      </div>
      <div class="kpi-info">
        <span class="kpi-label">Total Task Volume</span>
        <div class="kpi-val-row">
          <span class="kpi-value">${totalTasksCount}</span>
          <span class="kpi-pill neutral">${state.lists.length} lists · ${(state.projects || []).length} projects</span>
        </div>
      </div>
    </div>

    <div class="analytics-kpi-card accent-orange">
      <div class="kpi-icon-wrap">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      </div>
      <div class="kpi-info">
        <span class="kpi-label">Regular Task Efficiency</span>
        <div class="kpi-val-row">
          <span class="kpi-value">${regEfficiencyPct}%</span>
          <span class="kpi-pill warning">${regTasks.length} Cadences</span>
        </div>
      </div>
    </div>

    <div class="analytics-kpi-card accent-slate">
      <div class="kpi-icon-wrap">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 1 0 3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      </div>
      <div class="kpi-info">
        <span class="kpi-label">Registered Team</span>
        <div class="kpi-val-row">
          <span class="kpi-value">${registeredEmpsCount}</span>
          <span class="kpi-pill neutral">Active Members</span>
        </div>
      </div>
    </div>
  `;
  wrap.appendChild(kpiGrid);

  // --- Dynamic Filter Controls Toolbar ---
  const filterToolbar = document.createElement('div');
  filterToolbar.className = 'analytics-filter-toolbar';

  const registeredEmps = getAllEmployees();
  const empSelectOptions = registeredEmps.map((e) => `<option value="${escapeHtml(e)}" ${activeRegularEmployee === e ? 'selected' : ''}>${escapeHtml(e)}</option>`).join('');

  filterToolbar.innerHTML = `
    <div class="analytics-filter-group">
      <label for="analyticsEmpSelect" class="analytics-filter-label">Filter Analytics by Member:</label>
      <select id="analyticsEmpSelect" class="analytics-select-input">
        <option value="all" ${activeRegularEmployee === 'all' ? 'selected' : ''}>All Team Members</option>
        ${empSelectOptions}
      </select>
    </div>
  `;

  filterToolbar.querySelector('#analyticsEmpSelect').addEventListener('change', (e) => {
    activeRegularEmployee = e.target.value;
    render();
  });
  wrap.appendChild(filterToolbar);

  const chartDefinitions = [
    { id: 'cadence', title: 'Progress by cadence', subtitle: `Regular tasks — daily / weekly / monthly · ${scopeLabel}`, render: () => renderColumnChart({ data: chartCadenceProgress(), maxValue: 100, valueFormatter: (v) => `${v}%` }) },
    { id: 'trend', title: 'Completions trend', subtitle: `Regular tasks — last 30 days · ${scopeLabel}`, render: () => renderLineChart({ data: chartCompletionsTrend() }) },
    { id: 'heatmap', title: 'Activity heatmap', subtitle: `Regular tasks — last 14 weeks · ${scopeLabel}`, render: () => renderHeatmap({ data: chartCompletionsHeatmap() }) },
    { id: 'weekday', title: 'Completions by weekday', subtitle: `Regular tasks — all-time · ${scopeLabel}`, render: () => renderColumnChart({ data: chartCompletionsByWeekday() }) },
    { id: 'priority', title: 'Tasks by priority', subtitle: 'All lists', render: () => renderPieChart({ data: chartPriorityBreakdown() }) },
    { id: 'status', title: 'Tasks by status', subtitle: 'All lists', render: () => renderPieChart({ data: chartStatusBreakdown() }) },
    { id: 'perlist', title: 'Tasks per list', subtitle: 'Open tasks', render: () => renderColumnChart({ data: chartTasksPerList() }) },
    { id: 'employee', title: 'Regular tasks by employee', subtitle: `Completion % · ${scopeLabel}`, render: () => renderColumnChart({ data: chartEmployeeProgress(), maxValue: 100, valueFormatter: (v) => `${v}%` }) },
  ];

  const customOrder = state.chartsOrder?.[employeeKey] || chartDefinitions.map((c) => c.id);
  const orderedCharts = [];
  customOrder.forEach((id) => {
    const chart = chartDefinitions.find((c) => c.id === id);
    if (chart) orderedCharts.push(chart);
  });
  chartDefinitions.forEach((chart) => {
    if (!customOrder.includes(chart.id)) orderedCharts.push(chart);
  });

  const grid = document.createElement('div');
  grid.className = 'charts-grid';

  orderedCharts.forEach((chartDef, index) => {
    const card = renderChartCard(chartDef.title, chartDef.subtitle, chartDef.render());
    card.dataset.chartId = chartDef.id;
    makeResizable(card, `chart:${chartDef.id}`);
    card.draggable = true;
    card.style.cursor = 'grab';

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', chartDef.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromId = e.dataTransfer.getData('text/plain');
      if (fromId === chartDef.id) return;

      const currentOrder = orderedCharts.map((c) => c.id);
      const fromIndex = currentOrder.indexOf(fromId);
      const toIndex = currentOrder.indexOf(chartDef.id);

      if (fromIndex === -1 || toIndex === -1) return;

      const newOrder = [...currentOrder];
      newOrder.splice(fromIndex, 1);
      newOrder.splice(toIndex, 0, fromId);

      if (!state.chartsOrder) state.chartsOrder = {};
      state.chartsOrder[employeeKey] = newOrder;
      persist();
      render();
    });

    grid.appendChild(card);
  });

  wrap.appendChild(grid);
  return wrap;
}

function renderChartsDashboardHeader() {
  dashboardTitleEl.textContent = activeRegularEmployee === 'all' ? 'Analytics' : `Analytics — ${activeRegularEmployee}`;
  statsEl.innerHTML = '';
  const activeLists = getActiveLists();
  const tasks = activeLists.flatMap((list) => list.tasks);
  const open = tasks.filter((task) => !task.done).length;
  const done = tasks.filter((task) => task.done).length;
  const regularPct = regularOverallProgress();

  [
    ['Open tasks', open],
    ['Completed', done],
    ['Lists', activeLists.length],
    ['Regular progress', `${regularPct}%`],
  ].forEach(([label, value]) => {
    const stat = document.createElement('div');
    stat.className = 'stat-card open';
    stat.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    statsEl.appendChild(stat);
  });
}

// ---------- global UI wiring ----------

document.addEventListener('click', () => {
  document.querySelectorAll('.list-menu').forEach((m) => m.classList.add('hidden'));
  document.querySelectorAll('.view-dropdown.open').forEach((m) => m.classList.remove('open'));
  document.querySelectorAll('.stat-card-dropdown.open').forEach((m) => m.classList.remove('open'));
});

const viewMenuBtn = document.querySelector('.view-menu-btn');
const viewDropdown = document.querySelector('.view-dropdown');
if (viewMenuBtn && viewDropdown) {
  viewMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    viewDropdown.classList.toggle('open');
  });
  viewDropdown.addEventListener('click', (e) => e.stopPropagation());
}

document.getElementById('archivedListsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  openArchivedListsMenu(e.currentTarget);
});

document.getElementById('globalAddTaskBtn').addEventListener('click', () => {
  openItemPopup();
});

// analyticsBtn/kraBtn/registerBtn/checkinBtn/leaveBtn/exitBtn are all
// rendered fresh inside renderSidebar() now, with their click handlers
// attached at creation time -- there's no static element to wire here.

// The sidebar is freely drag-resizable (down to 0 width, i.e. fully
// hidden) via #sidebarResizeHandle, plus a one-click toggle that jumps
// between 0 and whatever width was last in use.
const SIDEBAR_MIN_WIDTH = 0;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 232;
const SIDEBAR_SNAP_THRESHOLD = 28;

function loadSidebarWidth() {
  try {
    const stored = localStorage.getItem('tikona_sidebar_width_v1');
    if (stored === null) return SIDEBAR_DEFAULT_WIDTH;
    const raw = Number(stored);
    return Number.isFinite(raw) && raw >= 0 ? raw : SIDEBAR_DEFAULT_WIDTH;
  } catch (err) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function saveSidebarWidth(px) {
  try {
    localStorage.setItem('tikona_sidebar_width_v1', String(px));
  } catch (err) {
    // Width just won't persist across reloads if localStorage is unavailable.
  }
}

const appSidebarEl = document.getElementById('appSidebar');
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
const sidebarResizeHandle = document.getElementById('sidebarResizeHandle');

function setSidebarWidth(px, { persist = true } = {}) {
  const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, px));
  const hidden = clamped <= SIDEBAR_SNAP_THRESHOLD;
  // Set on :root, not #appSidebar itself -- the resize handle and toggle
  // button live outside the sidebar now (siblings in .dashboard-shell) so
  // that positioning them at the sidebar's current edge doesn't get
  // clipped by the sidebar's own overflow-x: hidden. A :root custom
  // property is inherited by all three regardless of DOM position.
  document.documentElement.style.setProperty('--sidebar-width', `${hidden ? 0 : clamped}px`);
  appSidebarEl.classList.toggle('collapsed', hidden);
  sidebarToggleBtn.title = hidden ? 'Show sidebar' : 'Hide sidebar';
  if (persist) saveSidebarWidth(hidden ? 0 : clamped);
  return hidden ? 0 : clamped;
}

let lastExpandedSidebarWidth = SIDEBAR_DEFAULT_WIDTH;
const initialSidebarWidth = loadSidebarWidth();
if (initialSidebarWidth > SIDEBAR_SNAP_THRESHOLD) lastExpandedSidebarWidth = initialSidebarWidth;
setSidebarWidth(initialSidebarWidth, { persist: false });

sidebarToggleBtn.addEventListener('click', () => {
  if (appSidebarEl.classList.contains('collapsed')) {
    setSidebarWidth(lastExpandedSidebarWidth || SIDEBAR_DEFAULT_WIDTH);
  } else {
    lastExpandedSidebarWidth = appSidebarEl.getBoundingClientRect().width || SIDEBAR_DEFAULT_WIDTH;
    setSidebarWidth(0);
  }
});

let sidebarDragging = false;
sidebarResizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  sidebarDragging = true;
  appSidebarEl.classList.add('resizing');
  document.body.style.cursor = 'ew-resize';
});
document.addEventListener('mousemove', (e) => {
  if (!sidebarDragging) return;
  const left = appSidebarEl.getBoundingClientRect().left;
  const width = Math.max(0, Math.min(SIDEBAR_MAX_WIDTH, e.clientX - left));
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
});
document.addEventListener('mouseup', () => {
  if (!sidebarDragging) return;
  sidebarDragging = false;
  appSidebarEl.classList.remove('resizing');
  document.body.style.cursor = '';
  const current = parseFloat(getComputedStyle(appSidebarEl).getPropertyValue('--sidebar-width')) || 0;
  const finalWidth = setSidebarWidth(current);
  if (finalWidth > SIDEBAR_SNAP_THRESHOLD) lastExpandedSidebarWidth = finalWidth;
});

// --- Command Palette Logic ---
const searchTriggerBtn = document.getElementById('searchTriggerBtn');
const cpOverlay = document.getElementById('commandPalette');
const cpInput = document.getElementById('cpInput');
const cpCloseBtn = document.getElementById('cpCloseBtn');
const cpResults = document.getElementById('cpResults');

function openCommandPalette() {
  cpOverlay.classList.remove('hidden');
  cpInput.value = '';
  renderCpResults('');
  setTimeout(() => cpInput.focus(), 50);
}

function closeCommandPalette() {
  cpOverlay.classList.add('hidden');
  cpInput.value = '';
}

searchTriggerBtn.addEventListener('click', openCommandPalette);
cpCloseBtn.addEventListener('click', closeCommandPalette);

// Close on click outside
cpOverlay.addEventListener('mousedown', (e) => {
  if (e.target === cpOverlay) closeCommandPalette();
});

// Cmd+K shortcut
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    openCommandPalette();
  }
  if (e.key === 'Escape' && !cpOverlay.classList.contains('hidden')) {
    closeCommandPalette();
  }
});

cpInput.addEventListener('input', () => {
  renderCpResults(cpInput.value);
});

function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const escapedText = escapeHtml(text);
  const regex = new RegExp(`(${escapeHtml(query)})`, 'gi');
  return escapedText.replace(regex, '<span class="cp-highlight">$1</span>');
}

function renderCpResults(query) {
  cpResults.innerHTML = '';
  const q = query.trim().toLowerCase();

  if (!q) {
    cpResults.innerHTML = `
      <div class="cp-empty">
        Type to search for tasks, projects, or employees...<br>
        <small style="opacity:0.6; margin-top:8px; display:inline-block">You can also try quick filters like "status:done" (coming soon!)</small>
      </div>`;
    return;
  }

  let totalResults = 0;

  // 1. Search Tasks
  const allTasks = (state.lists || []).flatMap(l => l.tasks || []);
  const tasks = allTasks.filter(t => (t.text || '').toLowerCase().includes(q)).slice(0, 5);
  if (tasks.length) {
    const groupLabel = document.createElement('div');
    groupLabel.className = 'cp-group-header';
    groupLabel.textContent = 'Tasks';
    cpResults.appendChild(groupLabel);

    tasks.forEach(task => {
      const item = document.createElement('div');
      item.className = 'cp-item';
      item.innerHTML = `
        <div class="cp-item-icon">✔️</div>
        <div class="cp-item-content">
          <div class="cp-item-title">${highlightText(task.text, q)}</div>
          <div class="cp-item-subtitle">${task.status || 'open'}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        closeCommandPalette();
        searchQuery = task.text; 
        render();
      });
      cpResults.appendChild(item);
      totalResults++;
    });
  }

  // 2. Search Projects
  const projects = getActiveLists().filter(l => (l.name || '').toLowerCase().includes(q)).slice(0, 3);
  if (projects.length) {
    const groupLabel = document.createElement('div');
    groupLabel.className = 'cp-group-header';
    groupLabel.textContent = 'Projects';
    cpResults.appendChild(groupLabel);

    projects.forEach(proj => {
      const item = document.createElement('div');
      item.className = 'cp-item';
      item.innerHTML = `
        <div class="cp-item-icon">📁</div>
        <div class="cp-item-content">
          <div class="cp-item-title">${highlightText(proj.name, q)}</div>
          <div class="cp-item-subtitle">Project</div>
        </div>
      `;
      item.addEventListener('click', () => {
        closeCommandPalette();
        searchQuery = proj.name; 
        render();
      });
      cpResults.appendChild(item);
      totalResults++;
    });
  }

  // 3. Search Employees
  const employees = state.employees.filter(e => (e.name || '').toLowerCase().includes(q)).slice(0, 3);
  if (employees.length) {
    const groupLabel = document.createElement('div');
    groupLabel.className = 'cp-group-header';
    groupLabel.textContent = 'Employees';
    cpResults.appendChild(groupLabel);

    employees.forEach(emp => {
      const item = document.createElement('div');
      item.className = 'cp-item';
      item.innerHTML = `
        <div class="cp-item-icon">👤</div>
        <div class="cp-item-content">
          <div class="cp-item-title">${highlightText(emp.name, q)}</div>
          <div class="cp-item-subtitle">${highlightText(emp.email, q)}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        closeCommandPalette();
        activeRegularEmployee = emp.email;
        activeProjectEmployee = emp.email;
        render();
      });
      cpResults.appendChild(item);
      totalResults++;
    });
  }

  if (totalResults === 0) {
    cpResults.innerHTML = `<div class="cp-empty">No results found for "${escapeHtml(query)}"</div>`;
  }
}
// ------------------------------

document.querySelectorAll('.view-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    viewMode = btn.dataset.view;
    saveViewMode(viewMode);
    if (viewDropdown) viewDropdown.classList.remove('open');
    render();
  });
});

// ---------- Mobile Bottom Navigation ----------
const mobileNavBtns = document.querySelectorAll('.mobile-nav-btn');
if (mobileNavBtns.length) {
  mobileNavBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      
      mobileNavBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      switch (action) {
        case 'tasks':
          activeWorkspace = 'tasks';
          activeListId = 'all';
          render();
          break;
        case 'tabs':
          activeWorkspace = 'kra';
          render();
          break;
        case 'log':
          openAttendancePopup();
          break;
        case 'analytics':
          activeWorkspace = 'charts';
          render();
          break;
        case 'reports':
          activeWorkspace = 'productivity';
          render();
          break;
        case 'hr':
          openRegisterPopup();
          break;
      }
    });
  });
}

const mobileFabAddBtn = document.getElementById('mobileFabAdd');
if (mobileFabAddBtn) {
  mobileFabAddBtn.addEventListener('click', () => {
    openItemPopup();
  });
}

// ---------- boot ----------

function ensureDefaultList() {
  if (!VIEW_MODES.has(viewMode)) viewMode = 'board';
  if (!state.lists.length) {
    console.log('No lists found, creating default list');
    state.lists.push({ id: uid('list'), name: 'My Tasks', sections: [], tasks: [] });
  }
}

function safeRender() {
  try {
    render();
  } catch (err) {
    console.error('Render failed:', err);
    showFatal('Tasklist could not render. Saved data was reset for this session.', err);
    state = normalizeState({ lists: [{ id: uid('list'), name: 'My Tasks', sections: [], tasks: [] }] });
    render();
  }
}

// Applies a state that arrived from Supabase after boot (either the
// post-boot reconciliation or a background poll picking up a change made
// on another device/tab) and re-renders with it.
function applyRemoteState(rawState) {
  state = normalizeState(rawState);
  ensureDefaultList();
  safeRender();
}

async function boot() {
  console.log('Starting boot process...');

  // Local-first: paint immediately from whatever was cached last time, so
  // the UI never sits waiting on a network round-trip just to show the
  // board you already had open.
  const cached = loadCachedState();
  if (cached) {
    state = normalizeState(cached);
    ensureDefaultList();
    safeRender();
  }

  try {
    const fresh = normalizeState(await loadState());
    if (!cached || JSON.stringify(fresh) !== JSON.stringify(state)) {
      console.log('State reconciled from Supabase:', fresh);
      state = fresh;
      ensureDefaultList();
      safeRender();
    }
  } catch (err) {
    console.error('Tikona Tasklist load failed', err);
    if (!cached) {
      state = normalizeState({ lists: [] });
      ensureDefaultList();
      safeRender();
    }
  }

  // Pick up changes made from another tab or device without needing a
  // manual refresh.
  startPolling(applyRemoteState);

  // The copy-status icon's color depends on wall-clock time (it flips to
  // red right at the 6 PM window boundary -- see COPY_STATUS_RESET_HOUR),
  // with no underlying data changing, so without *something* checking
  // periodically it'd sit stale until an unrelated action happened to
  // trigger a render. A blind render() every 60s was tried first and
  // reverted -- render() fully rebuilds the board from scratch, and
  // doing that every single minute forever meant a real chance of it
  // landing in the split second between hovering a row and clicking one
  // of its icons, silently swallowing the click (the old element gets
  // removed right as the mouseup fires). This only re-renders once, at
  // the actual moment the window boundary is crossed -- not 1440
  // chances a day for the race, just one -- and skips it if a popup is
  // open at that exact moment (next minute's check will still catch it).
  let lastEveningWindowState = isEveningUpdateWindow();
  setInterval(() => {
    if (activeWorkspace !== 'tasks') return;
    const nowEvening = isEveningUpdateWindow();
    if (nowEvening === lastEveningWindowState) return;
    if (document.querySelector('.item-popup-overlay, .regular-popup-overlay')) return;
    lastEveningWindowState = nowEvening;
    render();
  }, 60000);
}

boot();

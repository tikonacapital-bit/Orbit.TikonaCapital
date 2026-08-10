
// Choose storage backend: './storage.js' for chrome.storage, './storage-supabase.js' for Supabase
import { loadState, loadCachedState, saveStateDebounced, startPolling, fetchLatestState } from './storage-supabase.js';

const boardEl = document.getElementById('board');
const statsEl = document.getElementById('stats');
const dashboardTitleEl = document.getElementById('dashboardTitle');
const mainViewActionsEl = document.getElementById('mainViewActions');
const kraViewActionsEl = document.getElementById('kraViewActions');
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
let sidebarTasksExpanded = true;
let sidebarTabsExpanded = false;
let viewMode = loadViewMode();
const VIEW_MODES = new Set(['board', 'table', 'stack', 'calendar']);

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

function dueLabel(due) {
  if (!due) return { text: '', cls: '' };
  const today = todayStr();
  const [y, m, dd] = due.split('-').map(Number);
  const label = `Due ${MONTHS[m - 1]} ${dd}`;
  if (due < today) return { text: `Overdue ${MONTHS[m - 1]} ${dd}`, cls: 'overdue' };
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

function normalizeActivity(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.email === 'string')
    .map((a) => ({
      id: a.id || uid('act'),
      type: ['register', 'checkin', 'checkout'].includes(a.type) ? a.type : 'checkin',
      name: typeof a.name === 'string' ? a.name : '',
      email: a.email,
      timestamp: Number.isFinite(a.timestamp) ? a.timestamp : Date.now(),
      ip: typeof a.ip === 'string' ? a.ip : '',
      device: typeof a.device === 'string' ? a.device : '',
    }));
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
    }))
    .slice(0, DELETED_TASKS_RETENTION);
}

function formatDateStrForShare(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function buildListShareText(list) {
  const priorityEmoji = { high: '🔴', medium: '🟠', low: '🔵', none: '⚪' };
  const tasks = (list.tasks || [])
    .filter((t) => !t.done)
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const lines = [`📋 *${list.name}* — Pending Tasks`, ''];
  if (!tasks.length) {
    lines.push('_No pending tasks._');
  } else {
    tasks.forEach((task, i) => {
      lines.push(`${i + 1}. ⬜ *${task.text}*`);
      const priority = task.priority || 'none';
      const meta = [`${priorityEmoji[priority] || priorityEmoji.none} ${priority.charAt(0).toUpperCase()}${priority.slice(1)}`];
      if (task.category) meta.push(`🏷 ${task.category}`);
      lines.push(`   ${meta.join('   ')}`);
      const statusLine = [`Status: ${task.status || 'Pending'}`];
      const dueText = formatDateStrForShare(task.due);
      if (dueText) statusLine.push(`Due: ${dueText}`);
      lines.push(`   ${statusLine.join('   |   ')}`);
      lines.push('');
    });
  }
  lines.push(`_Open: ${tasks.length}_`);
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
  const { overlay, popup, confirmBtn } = openRegularPopup('Register Employee', `
    <div class="popup-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
      <div>
        <label style="${FIELD_LABEL_STYLE}">Full name *</label>
        <input type="text" id="registerName" placeholder="Jane Doe" style="${FIELD_STYLE}">
      </div>
      <div>
        <label style="${FIELD_LABEL_STYLE}">Email address *</label>
        <input type="email" id="registerEmail" placeholder="you@company.com" style="${FIELD_STYLE}">
      </div>
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

  confirmBtn.addEventListener('click', () => {
    const name = popup.querySelector('#registerName').value.trim();
    const email = popup.querySelector('#registerEmail').value.trim().toLowerCase();
    const joiningDate = popup.querySelector('#registerJoiningDate').value;
    const endDate = popup.querySelector('#registerEndDate').value;
    if (!name) { alert("Please enter the employee's name."); return; }
    if (!EMAIL_RE.test(email)) { alert('Please enter a valid email address.'); return; }
    if (!joiningDate) { alert('Please select a joining date.'); return; }
    if (isEmailRegistered(email)) { alert('This email is already registered.'); return; }

    state.employees = state.employees || [];
    state.employees.push({ name, email, joiningDate, endDate: endDate || '', registeredAt: Date.now() });

    const hasList = state.lists.some((l) => !l.archived && sameEmployee(l.name, name));
    if (!hasList) addList(name);

    overlay.remove();
    logActivity('register', email, '', navigator.userAgent, name);
    showToast(`Registered ${name}`);
  });
}

function getTodayActivity(email, type) {
  const key = dateKey(new Date());
  return (state.activity || []).find((a) => a.email === email && a.type === type && dateKey(new Date(a.timestamp)) === key);
}

function fmtTimeOnly(ts) {
  const d = new Date(ts);
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${mins}`;
}

function openAttendancePopup() {
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
    ? 'Sign in with the Google account matching your registered email to check yourself in or out.'
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
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid ${isSelf ? '#1F4690' : '#eee'};border-radius:8px;${isSelf ? '' : 'opacity:0.6;'}`;

      const nameEl = document.createElement('span');
      nameEl.style.cssText = 'font-weight:600;font-size:13px;';
      nameEl.textContent = emp.name || emp.email;
      row.appendChild(nameEl);

      const actionsWrap = document.createElement('div');
      actionsWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';

      const checkin = getTodayActivity(emp.email, 'checkin');
      const checkout = getTodayActivity(emp.email, 'checkout');
      const canAct = !configured || isSelf;

      if (!checkin) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Check In';
        btn.disabled = !canAct;
        btn.title = canAct ? '' : 'Sign in with this person’s Google account to check them in';
        btn.style.cssText = `padding:6px 12px;border:none;border-radius:999px;background:${canAct ? '#FFA500' : '#c7ccd6'};color:#fff;font-size:12px;font-weight:600;cursor:${canAct ? 'pointer' : 'not-allowed'};`;
        btn.addEventListener('click', async () => {
          if (!canAct) return;
          btn.disabled = true;
          btn.textContent = '…';
          const ip = await fetchClientIp();
          logActivity('checkin', emp.email, ip, navigator.userAgent, emp.name);
          renderRows();
        });
        actionsWrap.appendChild(btn);
      } else {
        const inTime = document.createElement('span');
        inTime.style.cssText = 'font-size:11.5px;color:#3A5BA0;font-weight:600;';
        inTime.textContent = `In ${fmtTimeOnly(checkin.timestamp)}`;
        actionsWrap.appendChild(inTime);

        if (!checkout) {
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
        } else {
          const outTime = document.createElement('span');
          outTime.style.cssText = 'font-size:11.5px;color:#1F4690;font-weight:600;';
          outTime.textContent = `Out ${fmtTimeOnly(checkout.timestamp)}`;
          actionsWrap.appendChild(outTime);
        }
      }

      row.appendChild(actionsWrap);
      list.appendChild(row);
    });
  }
  renderRows();

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

  const list = state.lists.find((l) => sameEmployee(l.name, employee.name));

  const projectMemberships = [];
  state.projects.forEach((project) => {
    if (project.owners && project.owners.some((o) => sameEmployee(o, employee.name))) {
      projectMemberships.push({ projectId: project.id, projectName: project.name });
      project.owners = project.owners.filter((o) => !sameEmployee(o, employee.name));
      if (sameEmployee(project.owner, employee.name)) {
        project.owner = project.owners[0] || 'Unassigned';
      }
    }
  });

  const regularTasks = (state.regular.tasks || []).filter((t) => sameEmployee(t.owner, employee.name));
  state.regular.tasks = (state.regular.tasks || []).filter((t) => !sameEmployee(t.owner, employee.name));

  const activityEntries = (state.activity || []).filter((a) => a.email === employee.email);
  state.activity = (state.activity || []).filter((a) => a.email !== employee.email);

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

  entry.projectMemberships.forEach(({ projectId, projectName }) => {
    const project = state.projects.find((p) => p.id === projectId) || state.projects.find((p) => p.name === projectName);
    if (project) {
      project.owners = project.owners || [];
      if (!project.owners.some((o) => sameEmployee(o, entry.employee.name))) {
        project.owners.push(entry.employee.name);
      }
      if (!project.owner || project.owner === 'Unassigned') project.owner = entry.employee.name;
    }
  });

  state.regular.tasks = state.regular.tasks || [];
  entry.regularTasks.forEach((task) => {
    if (!state.regular.tasks.some((t) => t.id === task.id)) state.regular.tasks.push(task);
  });

  state.activity = state.activity || [];
  entry.activity.forEach((a) => {
    if (!state.activity.some((existing) => existing.id === a.id)) state.activity.push(a);
  });

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

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.textContent = 'Restore';
      restoreBtn.style.cssText = 'padding:6px 12px;border:none;border-radius:999px;background:#1F4690;color:#fff;font-size:12px;font-weight:600;cursor:pointer;';
      restoreBtn.addEventListener('click', () => {
        restoreEmployee(entry.id);
        overlay.remove();
        showToast(`${entry.employee.name || entry.employee.email} restored.`);
      });
      row.appendChild(restoreBtn);

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
    <div style="margin-bottom:10px;position:relative;">
      <label style="${FIELD_LABEL_STYLE}">Category — groups this task under the chosen cadence</label>
      <input type="text" id="regRowCategory" placeholder="e.g. Social Media" autocomplete="off" style="${FIELD_STYLE}">
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
    if (category && !state.categories.some((c) => c.toLowerCase() === category.toLowerCase())) {
      state.categories.push(category);
    }
    // The group is always just the cadence -- category is a separate field
    // that nests as a sub-section INSIDE that cadence's block, not a
    // parallel top-level section of its own.
    const group = cadenceLabel(cadence);

    const details = { cadence, owner, title, category, group };
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
  if (state.regular.completions[key]) delete state.regular.completions[key];
  else state.regular.completions[key] = true;
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

// "Archived / + Add / + New list" only makes sense for the main task
// board -- Tabs gets its own single "+ Add Website" action instead, and
// Analytics gets none. Only one of the two viewbar-actions containers is
// ever shown at a time.
function setViewbarActions(mode) {
  mainViewActionsEl.classList.toggle('hidden', mode !== 'main');
  kraViewActionsEl.classList.toggle('hidden', mode !== 'kra');
  if (mode !== 'kra') kraViewActionsEl.innerHTML = '';
}

function render() {
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

    if (viewMode === 'table') {
      boardTop.appendChild(renderTableView());
    } else if (viewMode === 'stack') {
      boardTop.appendChild(renderStackView());
    } else if (viewMode === 'calendar') {
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

function getEmployeeAttendanceLabel(listName) {
  const emp = getRegisteredEmployees().find((e) => sameEmployee(e.name, listName));
  if (!emp) return null;
  const checkin = getTodayActivity(emp.email, 'checkin');
  if (!checkin) return null;
  const checkout = getTodayActivity(emp.email, 'checkout');
  if (!checkout) return { text: `In ${fmtTimeShort(checkin.timestamp)}`, done: false };
  return { text: `${fmtTimeShort(checkin.timestamp)}–${fmtTimeShort(checkout.timestamp)}`, done: true };
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

function getAttendanceRecord(email, dateKeyStr) {
  const dayActivity = (state.activity || []).filter((a) => a.email === email && dateKey(new Date(a.timestamp)) === dateKeyStr);
  const checkin = dayActivity.find((a) => a.type === 'checkin');
  const checkout = dayActivity.filter((a) => a.type === 'checkout').slice(-1)[0];
  return { checkin, checkout };
}

function renderAttendanceSection() {
  const section = document.createElement('section');
  section.className = 'regular-section attendance-section';

  const header = document.createElement('div');
  header.className = 'section-header secondary';
  const title = document.createElement('h2');
  title.textContent = 'Attendance';
  header.appendChild(title);
  section.appendChild(header);

  section.appendChild(renderAttendanceToolbar());
  section.appendChild(renderAttendanceTable());
  return section;
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
      const { checkin, checkout } = getAttendanceRecord(emp.email, key);
      const cellWrap = document.createElement('div');
      cellWrap.className = 'attendance-cell';
      const inLine = document.createElement('div');
      inLine.className = 'attendance-time in';
      inLine.textContent = checkin ? fmtTimeOnly(checkin.timestamp) : '—';
      const outLine = document.createElement('div');
      outLine.className = 'attendance-time out';
      outLine.textContent = checkout ? fmtTimeOnly(checkout.timestamp) : '—';
      cellWrap.appendChild(inLine);
      cellWrap.appendChild(outLine);
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

  const activity = [...(state.activity || [])].sort((a, b) => b.timestamp - a.timestamp);

  if (!activity.length) {
    section.appendChild(renderEmptyState('No employee activity tracked yet.'));
    return section;
  }

  const ACTIVITY_LABELS = { register: 'registered', checkin: 'checked in', checkout: 'checked out', leave: 'applied for leave' };
  const ACTIVITY_ICONS = { register: '📝', checkin: '➡️', checkout: '⬅️', leave: '🏖️' };

  const list = document.createElement('div');
  list.className = 'activity-list';
  activity.slice(0, 10).forEach((entry) => {
    const row = document.createElement('div');
    row.className = `activity-row activity-${entry.type}`;

    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.textContent = ACTIVITY_ICONS[entry.type] || '•';
    row.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'activity-info';

    const line1 = document.createElement('div');
    line1.className = 'activity-main';
    const dayCount = entry.type === 'leave' && Array.isArray(entry.leaveDates) ? entry.leaveDates.length : 0;
    line1.textContent = `${entry.name || entry.email} ${ACTIVITY_LABELS[entry.type] || entry.type}${dayCount > 1 ? ` (${dayCount} days)` : ''}`;
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
  const hasUnassigned = (state.projects || []).some((p) => !p.archived && (!p.owners || !p.owners.length));
  return hasUnassigned ? [...names, 'Unassigned'] : names;
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
  const activeProjects = projects.filter((p) => !p.done);
  const doneProjects = projects.filter((p) => p.done);

  const countEl = document.createElement('span');
  countEl.className = 'list-count';
  countEl.textContent = activeProjects.length || '';
  header.appendChild(countEl);

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
  wrap.className = 'completed-wrap';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'completed-toggle';
  toggle.innerHTML = `Completed (<span class="completed-count">${doneProjects.length}</span>)`;
  wrap.appendChild(toggle);
  const list = document.createElement('div');
  list.className = 'completed-list tasks-list hidden';
  doneProjects
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .forEach((project) => list.appendChild(renderProjectRow(project)));
  wrap.appendChild(list);
  toggle.addEventListener('click', () => list.classList.toggle('hidden'));
  card.appendChild(wrap);

  return card;
}

function deleteProject(project) {
  const idx = state.projects.findIndex((p) => p.id === project.id);
  if (idx === -1) return;
  const removed = state.projects.splice(idx, 1)[0];
  persist();
  render();
  showToast(`Deleted "${removed.name}"`, () => {
    state.projects.splice(idx, 0, removed);
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
    project.dueDate = input.value || null;
    persist();
    render();
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
    project.done = !project.done;
    project.completedAt = project.done ? Date.now() : null;
    project.progress = project.done ? 100 : (project.progress === 100 ? 0 : project.progress);
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

  const iconEl = document.createElement('span');
  iconEl.className = 'project-icon';
  iconEl.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  iconEl.style.color = 'var(--text-muted)';
  iconEl.style.display = 'inline-flex';
  iconEl.style.alignItems = 'center';
  textEl.parentNode.insertBefore(iconEl, textEl);

  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); textEl.textContent = project.name; textEl.blur(); }
  });
  textEl.addEventListener('blur', () => {
    const val = textEl.textContent.trim();
    if (!val) { textEl.textContent = project.name; return; }
    if (val !== project.name) { project.name = val; persist(); }
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
  const { text: dueText, cls: dueCls } = dueLabel(project.dueDate);
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
    task.done = !task.done;
    task.completedAt = task.done ? Date.now() : null;
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

function openItemPopup(existingItem = null, existingIsProject = false, presetAssignee = '', presetDueDate = '') {
  document.querySelectorAll('.item-popup-overlay').forEach((m) => m.remove());
  const isEdit = Boolean(existingItem);
  const isProjectItem = isEdit ? existingIsProject : false;

  const overlay = document.createElement('div');
  overlay.className = 'item-popup-overlay';

  const popup = document.createElement('div');
  popup.className = 'item-popup';
  popup.style.maxWidth = '480px';
  popup.style.maxHeight = '92vh';

  const employees = getAllEmployees();
  const titleText = isEdit ? `Edit ${isProjectItem ? 'Project' : 'Task'}` : 'Add New Task/Project';

  popup.innerHTML = `
    <h2 style="margin: 0 0 12px 0; font-size: 17px; font-weight: 600;">${titleText}</h2>

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
          <button type="button" class="item-priority-btn" data-priority="low" title="Low" style="flex: 1; padding: 7px; border: 2px solid #ddd; border-radius: 6px; background: white; cursor: pointer;">
            <span style="display: inline-block; width: 10px; height: 10px; background: #6C8BC4; border-radius: 50%;"></span>
          </button>
          <button type="button" class="item-priority-btn" data-priority="medium" title="Medium" style="flex: 1; padding: 7px; border: 2px solid #ddd; border-radius: 6px; background: white; cursor: pointer;">
            <span style="display: inline-block; width: 10px; height: 10px; background: #FFA500; border-radius: 50%;"></span>
          </button>
          <button type="button" class="item-priority-btn" data-priority="high" title="High" style="flex: 1; padding: 7px; border: 2px solid #ddd; border-radius: 6px; background: white; cursor: pointer;">
            <span style="display: inline-block; width: 10px; height: 10px; background: #E04858; border-radius: 50%;"></span>
          </button>
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
          ${(state.projects || []).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
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

    <div style="display: flex; align-items: center; justify-content: flex-end;">
      <div style="display: flex; gap: 10px;">
        <button type="button" id="cancelItemBtn" style="padding: 8px 20px; border: 1px solid #ddd; border-radius: 999px; background: white; cursor: pointer; font-size: 13.5px; font-weight: 500;">Cancel</button>
        <button type="button" id="saveItemBtn" style="padding: 8px 22px; border: none; border-radius: 999px; background: #FFA500; color: white; cursor: pointer; font-size: 13.5px; font-weight: 600; box-shadow: 0 2px 8px rgba(255, 165, 0, 0.35);">${isEdit ? 'Save Changes' : 'Add'}</button>
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
        mood: 'neutral',
        done: false,
        completedAt: null,
        progress: 0,
      };
      state.projects.push(newProject);
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
        };
        project.tasks.push(newTask);
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
    return `${activeRegularEmployee}'s Regular Tasks`;
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
  ['Employee', 'Task', 'Time', 'Status'].forEach((label) => {
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
    groupCell.colSpan = dates.length + 4;
    groupCell.textContent = group;
    groupRow.appendChild(groupCell);
    tbody.appendChild(groupRow);

    subgroups.forEach(({ category, tasks: rows }) => {
      if (category) {
        const subgroupRow = document.createElement('tr');
        subgroupRow.className = 'regular-subgroup-row';
        const subgroupCell = document.createElement('td');
        subgroupCell.colSpan = dates.length + 4;
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
  if (activeWorkspace === 'regular' || activeWorkspace === 'charts' || activeWorkspace === 'kra') {
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

    const attendance = getEmployeeAttendanceLabel(list.name);
    if (attendance) {
      const att = document.createElement('span');
      att.className = `list-attendance${attendance.done ? ' done' : ''}`;
      att.textContent = attendance.text;
      att.title = attendance.done ? 'Checked in & out today' : 'Checked in today';
      nameEl.after(att);
    }

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

  const copyListBtn = menu.querySelector('[data-action="copy-list"]');
  copyListBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.add('hidden');
    copyTextToClipboard(buildListShareText(list))
      .then(() => showToast('Copied — paste it in WhatsApp or anywhere'))
      .catch(() => showToast('Could not copy to clipboard'));
  });

  // sections
  const sectionsWrap = node.querySelector('.sections');
  (list.sections || []).forEach((section) => {
    sectionsWrap.appendChild(renderSection(list, section));
  });

  // unsectioned tasks
  const unsectioned = node.querySelector('.unsectioned');
  unsectioned.dataset.scrollKey = `${list.id}:unsectioned`;
  const topTasks = visibleTasks.filter((t) => !t.done && !t.sectionId);
  topTasks.forEach((task) => unsectioned.appendChild(renderTask(list, task)));

  // completed
  const completed = visibleTasks.filter((t) => t.done);
  const completedList = node.querySelector('.completed-list');
  completedList.dataset.scrollKey = `${list.id}:completed`;
  const completedCount = node.querySelector('.completed-count');
  completedCount.textContent = completed.length;
  completed
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .forEach((task) => completedList.appendChild(renderTask(list, task)));

  const completedToggle = node.querySelector('.completed-toggle');
  completedToggle.addEventListener('click', () => {
    completedList.classList.toggle('hidden');
    completedToggle.classList.toggle('expanded', !completedList.classList.contains('hidden'));
  });

  // deleted
  const deletedTasks = list.deletedTasks || [];
  const deletedList = node.querySelector('.deleted-list');
  const deletedCount = node.querySelector('.deleted-count');
  deletedCount.textContent = deletedTasks.length;
  deletedTasks.forEach((entry) => deletedList.appendChild(renderDeletedTaskRow(list, entry)));

  const deletedToggle = node.querySelector('.deleted-toggle');
  deletedToggle.addEventListener('click', () => {
    deletedList.classList.toggle('hidden');
    deletedToggle.classList.toggle('expanded', !deletedList.classList.contains('hidden'));
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

  const sectionTasks = filterTasks(list.tasks).filter((t) => !t.done && t.sectionId === section.id);
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

  if (task.description) {
    const descEl = document.createElement('div');
    descEl.className = 'task-description';
    descEl.textContent = task.description;
    node.querySelector('.task-body').insertBefore(descEl, node.querySelector('.task-meta'));
  }

  const deleteBtn = node.querySelector('.task-delete');
  deleteBtn.addEventListener('click', () => deleteTask(list, task));

  const dueEl = node.querySelector('.task-due');
  const { text: dueText, cls: dueCls } = dueLabel(task.due);
  dueEl.textContent = dueText;
  dueEl.className = `task-due ${dueCls}`;
  dueEl.addEventListener('click', () => openDatePicker(list, task, dueEl));

  const createdEl = node.querySelector('.task-created');
  createdEl.textContent = task.done && task.completedAt
    ? formatCompletedDate(task.completedAt)
    : `Started on ${fmtShort(task.createdAt)}`;

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
    const { text: dueText, cls: dueCls } = dueLabel(task.due);
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

    const { text: dueText, cls: dueCls } = dueLabel(task.due);
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
  // Tab navigation (switch/rename/remove/add) now lives entirely in the
  // sidebar's Tabs group -- no need to duplicate it here too.
  dashboardTitleEl.textContent = activeTab ? `Tabs — ${activeTab.name}` : 'Tabs';

  if (!activeTab) return wrap;

  // The add-website action lives in the viewbar itself (see
  // setViewbarActions), in the same spot Archived/+Add/+New list occupy
  // for the main board, instead of a second toolbar row inside the
  // workspace -- that second row was what pushed the actual content down
  // below where the equivalent main-board content starts.
  kraViewActionsEl.innerHTML = '';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'tab-add has-archived';
  addBtn.textContent = '+ Add Website';
  addBtn.addEventListener('click', () => openAddKraWidgetPopup(activeTab));
  kraViewActionsEl.appendChild(addBtn);

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
  if (task.done && !wasDone) fireConfetti();
  persist();
  render();
}

function setTaskProgress(list, task, value) {
  const wasDone = task.done;
  task.progress = value;
  task.done = value === 100;
  task.completedAt = task.done ? Date.now() : null;
  task.status = value === 100 ? 'Done' : (value === 0 ? 'Pending' : 'In Progress');
  if (task.done && !wasDone) fireConfetti();
  persist();
  render();
}

function setProjectProgress(project, value) {
  const wasDone = project.done;
  project.progress = value;
  project.done = value === 100;
  project.completedAt = project.done ? Date.now() : null;
  project.status = value === 100 ? 'Done' : (value === 0 ? 'Pending' : 'In Progress');
  if (project.done && !wasDone) fireConfetti();
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
  const entry = { id: uid('del'), task: removed, deletedAt: Date.now() };
  list.deletedTasks.unshift(entry);
  if (list.deletedTasks.length > DELETED_TASKS_RETENTION) list.deletedTasks.length = DELETED_TASKS_RETENTION;
  persist();
  render();
  showToast(`Deleted "${removed.text}"`, () => {
    list.tasks.splice(idx, 0, removed);
    list.deletedTasks = list.deletedTasks.filter((e) => e.id !== entry.id);
    persist();
    render();
  });
}

function restoreDeletedTask(list, entryId) {
  const idx = (list.deletedTasks || []).findIndex((e) => e.id === entryId);
  if (idx === -1) return;
  const [entry] = list.deletedTasks.splice(idx, 1);
  list.tasks.push(entry.task);
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

function addList(name) {
  const list = { id: uid('list'), name, sections: [], tasks: [] };
  state.lists.push(list);
  activeListId = list.id;
  persist();
  render();
}

function promptAddList() {
  const name = prompt('New list name (e.g. a person or category):');
  if (name && name.trim()) addList(name.trim());
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

document.getElementById('topAddListBtn').addEventListener('click', () => {
  promptAddList();
});

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
}

boot();

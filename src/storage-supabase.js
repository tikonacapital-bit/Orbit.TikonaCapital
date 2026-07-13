// Persistence layer backed by Supabase (Postgres) via the REST API.
// A single shared row holds the entire app state as JSONB — this mirrors
// the in-memory `state` object exactly, so there's no schema to keep in
// sync as the app's data shape evolves (lists, regular tasks, projects,
// chartsOrder all travel together, same as the old chrome.storage blob).
//
// Loading is local-first: the UI renders instantly from the local cache,
// then reconciles with Supabase in the background instead of blocking on
// a network round-trip. A background poll picks up changes made from
// other tabs/devices so the app updates itself without a manual refresh.

import { loadState as loadLegacyState } from './storage.js';

const SUPABASE_URL = 'https://losnzjvvkhrzweznkpvd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxvc256anZ2a2hyendlem5rcHZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1Nzg1NzUsImV4cCI6MjA5OTE1NDU3NX0.mC_Dk2mCsabJfY6x7PS6bIkLi09pnfh1hnsPhG6jyAE';

const STATE_ROW_ID = 'default';
const LOCAL_CACHE_KEY = 'tikona_tasklist_state_v1';
const REST_URL = `${SUPABASE_URL}/rest/v1/tikona_state`;

function isConfigured() {
  return !SUPABASE_URL.startsWith('YOUR_') && !SUPABASE_ANON_KEY.startsWith('YOUR_');
}

function authHeaders(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function cacheLocally(state) {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(state));
  } catch (err) {
    // Best-effort cache only; Supabase remains the source of truth.
  }
}

function readLocalCache() {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

const EMPTY_STATE = { lists: [], projects: [], regular: null, chartsOrder: {} };

// Timestamp of the state we last saved or pulled from Supabase, so the
// background poll can tell "someone else changed it" apart from "this is
// just echoing back the write we made a moment ago".
let lastKnownUpdatedAt = null;

// Returns whatever is in the local cache, synchronously, with no network
// call — used to paint the UI immediately on boot instead of waiting on
// Supabase. Returns null if there's nothing cached yet (first run).
export function loadCachedState() {
  return readLocalCache();
}

// A lightweight, one-off fetch of whatever's currently in Supabase, bypassing
// the local cache. Used right before writes that are prone to being made by
// two people at nearly the same moment (e.g. marking attendance) — since the
// whole app state is one JSON document, blindly saving a stale in-memory
// copy would silently overwrite whatever someone else just wrote. Returns
// null if unreachable or not configured.
export async function fetchLatestState() {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`${REST_URL}?id=eq.${STATE_ROW_ID}&select=data`, { headers: authHeaders() });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows.length ? rows[0].data : null;
  } catch (err) {
    return null;
  }
}

export async function loadState() {
  if (!isConfigured()) {
    console.warn('Tikona Tasklist: Supabase credentials not set in storage-supabase.js, falling back to local storage.');
    return loadLegacyState();
  }

  try {
    const res = await fetch(`${REST_URL}?id=eq.${STATE_ROW_ID}&select=data,updated_at`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Supabase load failed: ${res.status} ${await res.text().catch(() => '')}`);
    const rows = await res.json();

    if (rows.length && rows[0].data && Object.keys(rows[0].data).length) {
      lastKnownUpdatedAt = rows[0].updated_at;
      cacheLocally(rows[0].data);
      return rows[0].data;
    }

    // No row in Supabase yet — this is either a first run, or a switch away
    // from the old chrome.storage-only backend. Seed from whatever exists
    // locally so nothing already on this machine gets lost.
    const legacy = await loadLegacyState().catch(() => null);
    if (legacy && legacy.lists && legacy.lists.length) {
      await saveStateNow(legacy);
      return legacy;
    }
    return EMPTY_STATE;
  } catch (err) {
    console.warn('Tikona Tasklist: Supabase unreachable, using local cache', err);
    const cached = readLocalCache();
    if (cached) return cached;
    return loadLegacyState().catch(() => EMPTY_STATE);
  }
}

let saveTimer = null;
let pendingState = null;

export function saveStateDebounced(state, delay = 500) {
  pendingState = state;
  cacheLocally(state); // instant local cache so a refresh mid-debounce can't lose data
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStateNow(pendingState).catch((err) => console.error('Tikona Tasklist Supabase save failed', err));
  }, delay);
}

export async function saveStateNow(state) {
  cacheLocally(state);
  if (!isConfigured()) return;

  const nowIso = new Date().toISOString();
  const res = await fetch(`${REST_URL}?on_conflict=id`, {
    method: 'POST',
    headers: authHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ id: STATE_ROW_ID, data: state, updated_at: nowIso }),
  });
  if (!res.ok) {
    throw new Error(`Supabase save failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  lastKnownUpdatedAt = nowIso;
}

// Periodically checks Supabase for changes made elsewhere (another tab,
// another device) and calls onRemoteChange(data) when something new shows
// up. Skips the check whenever the tab is hidden, a local save is still
// queued (so we never clobber an edit that hasn't been written yet), or
// Supabase isn't configured. Returns a function that stops the polling.
export function startPolling(onRemoteChange, intervalMs = 6000) {
  if (!isConfigured()) return () => {};

  const tick = async () => {
    if (document.hidden || saveTimer) return;
    try {
      const res = await fetch(`${REST_URL}?id=eq.${STATE_ROW_ID}&select=data,updated_at`, { headers: authHeaders() });
      if (!res.ok) return;
      const rows = await res.json();
      if (!rows.length) return;
      const remoteUpdatedAt = rows[0].updated_at;
      if (lastKnownUpdatedAt && remoteUpdatedAt <= lastKnownUpdatedAt) return; // nothing new
      lastKnownUpdatedAt = remoteUpdatedAt;
      cacheLocally(rows[0].data);
      onRemoteChange(rows[0].data);
    } catch (err) {
      // Transient network issue — just try again next tick.
    }
  };

  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

export function exportStateAsJson(state) {
  return JSON.stringify(state, null, 2);
}

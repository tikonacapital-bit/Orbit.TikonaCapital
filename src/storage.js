// Persistence layer. Uses chrome.storage.sync when running as an extension
// (data follows the user's Chrome/Google account across devices, no server).
// Falls back to localStorage when opened as a plain webpage (e.g. for local
// preview/testing outside the extension).

const CHUNK_SIZE = 15; // tasks per storage chunk, keeps each item well under the 8KB/item sync quota
const INDEX_KEY = 'tikona_index_v1';
const REGULAR_KEY = 'tikona_regular_v1';
const PROJECTS_KEY = 'tikona_projects_v1';
const CHARTS_ORDER_KEY = 'tikona_charts_order_v1';
const LOCAL_FALLBACK_KEY = 'tikona_tasklist_state_v1';

const hasChromeSync = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;

function chunkKey(listId, i) {
  return `tikona_tasks_${listId}_${i}`;
}

function metaKey(listId) {
  return `tikona_meta_${listId}`;
}

async function syncGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result);
    });
  });
}

async function syncSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(items, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

async function syncRemove(keys) {
  if (keys.length === 0) return;
  return new Promise((resolve, reject) => {
    chrome.storage.sync.remove(keys, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

export async function loadState() {
  if (!hasChromeSync) {
    const raw = localStorage.getItem(LOCAL_FALLBACK_KEY);
    if (!raw) return { lists: [], projects: [], regular: null, chartsOrder: {} };
    try {
      const state = JSON.parse(raw);
      // Ensure all tasks have dueChangeCount
      if (state.lists) {
        state.lists = state.lists.map(list => ({
          ...list,
          tasks: (list.tasks || []).map(task => ({
            ...task,
            dueChangeCount: Number.isFinite(task.dueChangeCount) ? task.dueChangeCount : 0,
            startDate: typeof task.startDate === 'string' ? task.startDate : null,
            assignedTo: typeof task.assignedTo === 'string' ? task.assignedTo : '',
            mood: typeof task.mood === 'string' ? task.mood : 'neutral',
          }))
        }));
      }
      if (state.projects) {
        state.projects = state.projects.map(project => ({
          ...project,
          tasks: (project.tasks || []).map(task => ({
            ...task,
            dueChangeCount: Number.isFinite(task.dueChangeCount) ? task.dueChangeCount : 0,
            startDate: typeof task.startDate === 'string' ? task.startDate : null,
            assignedTo: typeof task.assignedTo === 'string' ? task.assignedTo : '',
            mood: typeof task.mood === 'string' ? task.mood : 'neutral',
          }))
        }));
      }
      return state;
    } catch (err) {
      console.warn('Tikona Tasklist load failed to parse local fallback', err);
      return { lists: [], projects: [], regular: null, chartsOrder: {} };
    }
  }

  const regularData = await syncGet([REGULAR_KEY]);
  const regular = regularData[REGULAR_KEY] || null;
  const projectsData = await syncGet([PROJECTS_KEY]);
  const projects = projectsData[PROJECTS_KEY] || null;
  const chartsOrderData = await syncGet([CHARTS_ORDER_KEY]);
  const chartsOrder = chartsOrderData[CHARTS_ORDER_KEY] || {};
  const indexData = await syncGet([INDEX_KEY]);
  const index = indexData[INDEX_KEY];
  if (!index) return { lists: [], regular, projects, chartsOrder };

  const lists = [];
  for (const listRef of index.listOrder) {
    const mKey = metaKey(listRef);
    const metaData = await syncGet([mKey]);
    const meta = metaData[mKey];
    if (!meta) continue;

    const chunkKeys = [];
    for (let i = 0; i < meta.chunkCount; i++) chunkKeys.push(chunkKey(listRef, i));
    const chunkData = chunkKeys.length ? await syncGet(chunkKeys) : {};
    let tasks = [];
    for (let i = 0; i < meta.chunkCount; i++) {
      tasks = tasks.concat(chunkData[chunkKey(listRef, i)] || []);
    }

    lists.push({
      id: listRef,
      name: meta.name,
      sections: meta.sections || [],
      tasks: tasks.map(task => ({
        ...task,
        dueChangeCount: Number.isFinite(task.dueChangeCount) ? task.dueChangeCount : 0,
        startDate: typeof task.startDate === 'string' ? task.startDate : null,
        assignedTo: typeof task.assignedTo === 'string' ? task.assignedTo : '',
        mood: typeof task.mood === 'string' ? task.mood : 'neutral',
      })),
    });
  }

  return { lists, regular, projects, chartsOrder };
}

let saveTimer = null;
let pendingState = null;

export function saveStateDebounced(state, delay = 400) {
  pendingState = state;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStateNow(pendingState).catch((err) => console.error('Tikona Tasklist save failed', err));
  }, delay);
}

export async function saveStateNow(state) {
  if (!hasChromeSync) {
    localStorage.setItem(LOCAL_FALLBACK_KEY, JSON.stringify(state));
    return;
  }

  const listOrder = state.lists.map((l) => l.id);
  const writes = {
    [INDEX_KEY]: { listOrder },
    [REGULAR_KEY]: state.regular || null,
    [PROJECTS_KEY]: state.projects || null,
    [CHARTS_ORDER_KEY]: state.chartsOrder || {},
  };
  const keepKeys = new Set([INDEX_KEY, REGULAR_KEY, PROJECTS_KEY, CHARTS_ORDER_KEY]);

  for (const list of state.lists) {
    const chunks = [];
    for (let i = 0; i < list.tasks.length; i += CHUNK_SIZE) {
      chunks.push(list.tasks.slice(i, i + CHUNK_SIZE));
    }
    const meta = {
      name: list.name,
      sections: list.sections || [],
      chunkCount: chunks.length,
    };
    writes[metaKey(list.id)] = meta;
    keepKeys.add(metaKey(list.id));
    chunks.forEach((chunk, i) => {
      writes[chunkKey(list.id, i)] = chunk;
      keepKeys.add(chunkKey(list.id, i));
    });
  }

  await syncSet(writes);

  // Clean up stale keys from lists/chunks that no longer exist.
  const all = await new Promise((resolve, reject) => {
    chrome.storage.sync.get(null, (res) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(res);
    });
  });
  const staleKeys = Object.keys(all).filter(
    (k) => k.startsWith('tikona_') && !keepKeys.has(k)
  );
  await syncRemove(staleKeys);
}

export function exportStateAsJson(state) {
  return JSON.stringify(state, null, 2);
}

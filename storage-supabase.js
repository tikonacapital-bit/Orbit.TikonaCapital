// Supabase-based persistence layer for Tikona Tasklist
// This replaces chrome.storage.sync with Supabase for cloud storage

import { getSupabaseClient } from './supabase-client.js';

const CHUNK_SIZE = 15; // tasks per storage chunk
const LOCAL_FALLBACK_KEY = 'tikona_tasklist_state_v1';

// User identification (you can replace this with actual auth)
let userId = 'default_user';

function setUserId(id) {
  userId = id || 'default_user';
}

// Helper to generate unique IDs for database records
function generateId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Load state from Supabase
export async function loadState() {
  try {
    console.log('Loading state from Supabase for user:', userId);
    const supabase = getSupabaseClient();
    if (!supabase) {
      console.warn('Supabase client not available, falling back to localStorage');
      return loadFromLocalStorage();
    }

    // Load main state record
    console.log('Fetching main state record...');
    const stateData = await supabase.select('tasklist_state', {
      eq: { user_id: userId },
      single: true
    });

    console.log('State data received:', stateData);

    if (!stateData) {
      console.log('No existing state found in Supabase, returning empty state');
      return { lists: [], projects: [], regular: null, chartsOrder: {} };
    }

    // Load task chunks
    console.log('Fetching task chunks...');
    const chunks = await supabase.select('task_chunks', {
      eq: { user_id: userId }
    });

    console.log('Chunks received:', chunks?.length || 0, 'chunks');

    // Reconstruct lists from chunks
    const lists = [];
    if (stateData.lists_metadata) {
      for (const listMeta of stateData.lists_metadata) {
        const listChunks = chunks?.filter(c => c.list_id === listMeta.id) || [];
        const tasks = listChunks.flatMap(chunk => chunk.tasks || []);
        
        lists.push({
          id: listMeta.id,
          name: listMeta.name,
          sections: listMeta.sections || [],
          tasks: tasks.map(task => ({
            ...task,
            dueChangeCount: Number.isFinite(task.dueChangeCount) ? task.dueChangeCount : 0,
            startDate: typeof task.startDate === 'string' ? task.startDate : null,
            assignedTo: typeof task.assignedTo === 'string' ? task.assignedTo : '',
            mood: typeof task.mood === 'string' ? task.mood : 'neutral',
          }))
        });
      }
    }

    console.log('Reconstructed', lists.length, 'lists');

    // Ensure projects tasks have new fields
    const projects = (stateData.projects || []).map(project => ({
      ...project,
      tasks: (project.tasks || []).map(task => ({
        ...task,
        dueChangeCount: Number.isFinite(task.dueChangeCount) ? task.dueChangeCount : 0,
        startDate: typeof task.startDate === 'string' ? task.startDate : null,
        assignedTo: typeof task.assignedTo === 'string' ? task.assignedTo : '',
        mood: typeof task.mood === 'string' ? task.mood : 'neutral',
      }))
    }));

    return {
      lists,
      projects,
      regular: stateData.regular || null,
      chartsOrder: stateData.charts_order || {}
    };

  } catch (error) {
    console.error('Failed to load from Supabase, falling back to localStorage:', error);
    console.error('Error details:', error.message, error.code);
    return loadFromLocalStorage();
  }
}

// Save state to Supabase
export async function saveStateNow(state) {
  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      console.warn('Supabase client not available, saving to localStorage');
      return saveToLocalStorage(state);
    }

    // Prepare lists metadata
    const listsMetadata = state.lists.map(list => ({
      id: list.id,
      name: list.name,
      sections: list.sections
    }));

    // Prepare task chunks
    const taskChunks = [];
    for (const list of state.lists) {
      for (let i = 0; i < list.tasks.length; i += CHUNK_SIZE) {
        const chunk = list.tasks.slice(i, i + CHUNK_SIZE);
        taskChunks.push({
          id: generateId(),
          user_id: userId,
          list_id: list.id,
          chunk_index: Math.floor(i / CHUNK_SIZE),
          tasks: chunk
        });
      }
    }

    // Upsert main state record
    await supabase.upsert('tasklist_state', {
      user_id: userId,
      lists_metadata: listsMetadata,
      projects: state.projects || [],
      regular: state.regular || null,
      charts_order: state.chartsOrder || {},
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });

    // Delete old chunks for this user
    try {
      await supabase.delete('task_chunks', {
        eq: { user_id: userId }
      });
    } catch (deleteError) {
      console.warn('Error deleting old chunks:', deleteError);
    }

    // Insert new chunks
    if (taskChunks.length > 0) {
      await supabase.insert('task_chunks', taskChunks);
    }

    console.log('State saved to Supabase successfully');

  } catch (error) {
    console.error('Failed to save to Supabase, saving to localStorage:', error);
    saveToLocalStorage(state);
  }
}

// Debounced save (same as original)
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

// LocalStorage fallback functions
function loadFromLocalStorage() {
  const raw = localStorage.getItem(LOCAL_FALLBACK_KEY);
  if (!raw) return { lists: [], projects: [], regular: null, chartsOrder: {} };
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Tikona Tasklist load failed to parse local fallback', err);
    return { lists: [], projects: [], regular: null, chartsOrder: {} };
  }
}

function saveToLocalStorage(state) {
  localStorage.setItem(LOCAL_FALLBACK_KEY, JSON.stringify(state));
}

export function exportStateAsJson(state) {
  return JSON.stringify(state, null, 2);
}

export { setUserId };

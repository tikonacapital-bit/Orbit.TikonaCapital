// Supabase REST API client (no SDK needed for Chrome extensions)
const SUPABASE_URL = 'https://losnzjvvkhrzweznkpvd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxvc256anZ2a2hyendlem5rcHZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1Nzg1NzUsImV4cCI6MjA5OTE1NDU3NX0.mC_Dk2mCsabJfY6x7PS6bIkLi09pnfh1hnsPhG6jyAE';

const headers = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

// Simple REST API wrapper for Supabase
const supabaseRest = {
  async select(table, options = {}) {
    let url = `${SUPABASE_URL}/rest/v1/${table}`;
    const params = [];
    
    if (options.select) params.push(`select=${encodeURIComponent(options.select)}`);
    if (options.eq) {
      Object.entries(options.eq).forEach(([key, value]) => {
        params.push(`${key}=eq.${encodeURIComponent(value)}`);
      });
    }
    if (options.order) {
      params.push(`order=${encodeURIComponent(options.order)}`);
    }
    if (options.limit) {
      params.push(`limit=${options.limit}`);
    }
    
    if (params.length > 0) {
      url += '?' + params.join('&');
    }
    
    const response = await fetch(url, { headers });
    const data = await response.json();
    
    if (!response.ok) {
      throw { message: data.message || 'Error fetching data', code: response.status, data };
    }
    
    return options.single ? data[0] : data;
  },
  
  async insert(table, data) {
    const url = `${SUPABASE_URL}/rest/v1/${table}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(data)
    });
    const result = await response.json();
    
    if (!response.ok) {
      throw { message: result.message || 'Error inserting data', code: response.status, data: result };
    }
    
    return result;
  },
  
  async upsert(table, data, options = {}) {
    const url = `${SUPABASE_URL}/rest/v1/${table}`;
    const upsertHeaders = { ...headers, 'Prefer': 'resolution=ignore-duplicates,return=representation' };
    
    if (options.onConflict) {
      upsertHeaders['Prefer'] = `resolution=merge-duplicates,return=representation`;
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: upsertHeaders,
      body: JSON.stringify(Array.isArray(data) ? data : [data])
    });
    const result = await response.json();
    
    if (!response.ok) {
      throw { message: result.message || 'Error upserting data', code: response.status, data: result };
    }
    
    return Array.isArray(data) ? result : result[0];
  },
  
  async update(table, data, options = {}) {
    let url = `${SUPABASE_URL}/rest/v1/${table}`;
    const params = [];
    
    if (options.eq) {
      Object.entries(options.eq).forEach(([key, value]) => {
        params.push(`${key}=eq.${encodeURIComponent(value)}`);
      });
    }
    
    if (params.length > 0) {
      url += '?' + params.join('&');
    }
    
    const response = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(data)
    });
    const result = await response.json();
    
    if (!response.ok) {
      throw { message: result.message || 'Error updating data', code: response.status, data: result };
    }
    
    return result;
  },
  
  async delete(table, options = {}) {
    let url = `${SUPABASE_URL}/rest/v1/${table}`;
    const params = [];
    
    if (options.eq) {
      Object.entries(options.eq).forEach(([key, value]) => {
        params.push(`${key}=eq.${encodeURIComponent(value)}`);
      });
    }
    
    if (params.length > 0) {
      url += '?' + params.join('&');
    }
    
    const response = await fetch(url, {
      method: 'DELETE',
      headers
    });
    
    if (!response.ok) {
      const data = await response.json();
      throw { message: data.message || 'Error deleting data', code: response.status, data };
    }
    
    return null;
  }
};

function getSupabaseClient() {
  return supabaseRest;
}

export { getSupabaseClient, SUPABASE_URL, SUPABASE_ANON_KEY };

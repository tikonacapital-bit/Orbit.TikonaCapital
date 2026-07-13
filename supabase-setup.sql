-- Run this once in the Supabase SQL Editor for your project.
-- Creates a single table holding the whole Tikona Tasklist app state
-- as one JSONB document per row (one row per install, id = 'default').

create table if not exists public.tikona_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.tikona_state enable row level security;

-- Single shared row, accessed via the anon key with no login screen.
-- Anyone holding the anon key + project URL can read/write this table —
-- acceptable for a personal/internal tool, but note it before relying on it
-- for anything sensitive. Tighten with real auth + per-user policies later
-- if that changes.
create policy "anon can read tikona_state"
  on public.tikona_state for select
  using (true);

create policy "anon can insert tikona_state"
  on public.tikona_state for insert
  with check (true);

create policy "anon can update tikona_state"
  on public.tikona_state for update
  using (true)
  with check (true);

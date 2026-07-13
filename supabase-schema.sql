-- Supabase SQL Schema for Tikona Tasklist
-- Run this in your Supabase project's SQL Editor

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Main state table for each user
CREATE TABLE IF NOT EXISTS tasklist_state (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  lists_metadata JSONB DEFAULT '[]'::jsonb,
  projects JSONB DEFAULT '[]'::jsonb,
  regular JSONB,
  charts_order JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Task chunks table (for large task lists)
CREATE TABLE IF NOT EXISTS task_chunks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  tasks JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_tasklist_state_user_id ON tasklist_state(user_id);
CREATE INDEX IF NOT EXISTS idx_task_chunks_user_id ON task_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_task_chunks_list_id ON task_chunks(list_id);

-- Enable Row Level Security (RLS)
ALTER TABLE tasklist_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_chunks ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Allow read access to all states" ON tasklist_state;
DROP POLICY IF EXISTS "Allow insert/update states" ON tasklist_state;
DROP POLICY IF EXISTS "Allow read access to all chunks" ON task_chunks;
DROP POLICY IF EXISTS "Allow insert/update/delete chunks" ON task_chunks;

-- RLS policies for tasklist_state
-- Allow read access for all users (you may want to restrict this based on auth)
CREATE POLICY "Allow read access to all states"
  ON tasklist_state FOR SELECT
  USING (true);

-- Allow insert/update for all users (you may want to restrict this based on auth)
CREATE POLICY "Allow insert/update states"
  ON tasklist_state FOR ALL
  USING (true)
  WITH CHECK (true);

-- RLS policies for task_chunks
CREATE POLICY "Allow read access to all chunks"
  ON task_chunks FOR SELECT
  USING (true);

CREATE POLICY "Allow insert/update/delete chunks"
  ON task_chunks FOR ALL
  USING (true)
  WITH CHECK (true);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS update_tasklist_state_updated_at ON tasklist_state;
DROP TRIGGER IF EXISTS update_task_chunks_updated_at ON task_chunks;

-- Triggers to auto-update updated_at
CREATE TRIGGER update_tasklist_state_updated_at
  BEFORE UPDATE ON tasklist_state
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_task_chunks_updated_at
  BEFORE UPDATE ON task_chunks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Optional: Enable Realtime for live updates
-- Uncomment these lines if you want real-time sync
-- ALTER PUBLICATION supabase_realtime ADD TABLE tasklist_state;
-- ALTER PUBLICATION supabase_realtime ADD TABLE task_chunks;

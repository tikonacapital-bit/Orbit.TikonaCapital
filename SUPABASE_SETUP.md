# Supabase Integration Setup Guide

This guide will help you connect Tikona Tasklist to Supabase for cloud-based data storage.

## Prerequisites

1. A Supabase account (free tier works fine)
2. Basic understanding of database concepts

## Step 1: Create Supabase Project

1. Go to [https://supabase.com](https://supabase.com)
2. Sign up/log in and create a new project
3. Wait for your project to be provisioned (usually 1-2 minutes)

## Step 2: Get Your Credentials

1. Go to your project's **Settings** → **API**
2. Copy your **Project URL** and **anon public key**
3. Keep these safe - you'll need them in the next step

## Step 3: Configure the Application

1. Open `supabase-client.js` in your project
2. Replace the placeholder values:
   ```javascript
   const SUPABASE_URL = 'YOUR_SUPABASE_URL'; // Your actual project URL
   const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'; // Your actual anon key
   ```

## Step 4: Set Up Database Tables

1. Go to your Supabase project's **SQL Editor**
2. Copy the contents of `supabase-schema.sql`
3. Paste it into the SQL Editor
4. Click **Run** to execute the schema creation

This will create:
- `tasklist_state` table for main application state
- `task_chunks` table for storing large task lists
- Proper indexes and RLS policies
- Auto-update triggers for timestamps

## Step 5: Test the Integration

1. Load the extension in Chrome (or open index.html in a browser)
2. You'll be prompted for a user ID (enter any unique identifier)
3. Create some tasks and lists
4. Check your Supabase dashboard → **Table Editor** to see data being stored

## Step 6: Switch Between Storage Backends

The application supports both storage backends:

**To use Supabase (current setup):**
```javascript
// In src/app.js
import { loadState, saveStateDebounced, setUserId } from './storage-supabase.js';
```

**To use Chrome Storage (original):**
```javascript
// In src/app.js
import { loadState, saveStateDebounced } from './storage.js';
```

## Features

- **Cloud Storage**: Data stored in Supabase instead of Chrome storage
- **Multi-user Support**: Each user ID gets isolated data
- **Automatic Fallback**: Falls back to localStorage if Supabase is unavailable
- **Chunked Storage**: Large task lists are split into chunks for efficiency
- **Real-time Ready**: Schema supports Supabase Realtime for live sync (optional)

## Security Notes

- Current implementation uses the anon key (public access)
- For production, consider implementing proper authentication
- Review and adjust RLS policies based on your security requirements
- The current policies allow read/write access to all users

## Optional: Enable Real-time Sync

To enable real-time synchronization across multiple devices:

1. Go to your Supabase project → **Replication**
2. Enable replication for `tasklist_state` and `task_chunks` tables
3. Uncomment the realtime lines in `supabase-schema.sql`
4. Implement real-time subscription logic in `storage-supabase.js`

## Troubleshooting

**Connection Issues:**
- Check that your Supabase URL and anon key are correct
- Verify your browser can access `https://cdn.jsdelivr.net`
- Check browser console for error messages

**Data Not Saving:**
- Verify database tables were created successfully
- Check RLS policies allow write access
- Ensure your user ID is consistent

**Performance Issues:**
- The chunking system handles large task lists efficiently
- Consider adding more indexes if you have complex queries
- Monitor Supabase dashboard for performance metrics

## Migration from Chrome Storage

If you have existing data in Chrome storage:

1. Load the app with Chrome storage first
2. Export your data using the export functionality
3. Switch to Supabase backend
4. Import your data (you may need to add import functionality)

## Support

For issues specific to:
- **Supabase**: Check [Supabase Documentation](https://supabase.com/docs)
- **Tikona Tasklist**: Review the main application code and comments

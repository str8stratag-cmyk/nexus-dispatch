-- v3 migration: add audio_url column to dispatch_events table
-- Run this in your Supabase SQL Editor before deploying v3.

ALTER TABLE dispatch_events
ADD COLUMN IF NOT EXISTS audio_url text;

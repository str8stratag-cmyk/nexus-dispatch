-- v2 migration: add cross_street column to dispatch_events table
-- Run this in your Supabase SQL Editor before deploying v2.

ALTER TABLE dispatch_events
ADD COLUMN IF NOT EXISTS cross_street text;

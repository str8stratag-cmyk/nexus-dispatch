-- v4 migration: add telegram_message_id column to dispatch_events table
-- Stores the Telegram message ID so the dispatch message can be edited when a driver accepts the call.

ALTER TABLE dispatch_events
ADD COLUMN IF NOT EXISTS telegram_message_id text;

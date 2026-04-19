-- ═══════════════════════════════════════════════════════════════
--  STEP 1 — Create the database
--  ► In pgAdmin: connect to the default "postgres" database,
--    open Query Tool, and run ONLY the block below.
--    (CREATE DATABASE cannot run inside a transaction,
--     so run it separately before Step 2.)
-- ═══════════════════════════════════════════════════════════════

CREATE DATABASE converter_db
    WITH
    OWNER     = postgres
    ENCODING  = 'UTF8'
    LC_COLLATE = 'en-US'
    LC_CTYPE   = 'en-US'
    TEMPLATE  = template0
    CONNECTION LIMIT = -1;

COMMENT ON DATABASE converter_db IS 'M4A to MP3 audio converter database';


-- ═══════════════════════════════════════════════════════════════
--  STEP 2 — Create the conversions table
--  ► After running Step 1, switch your pgAdmin connection to
--    "converter_db" (click the database in the left panel,
--    then open a new Query Tool), then run the block below.
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Main conversions tracking table
CREATE TABLE IF NOT EXISTS conversions (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    original_name VARCHAR(255) NOT NULL,
    status        VARCHAR(20)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
    source        VARCHAR(20)  NOT NULL DEFAULT 'local',
    source_url    TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    download_url  TEXT
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_conversions_status
    ON conversions (status);

CREATE INDEX IF NOT EXISTS idx_conversions_created_at
    ON conversions (created_at DESC);

-- ═══════════════════════════════════════════════════════════════
--  STEP 3 — UPGRADE SCRIPT (Run this if you already created the DB)
--  ► If your database was already created before the YouTube update,
--    run these two lines to add the tracking columns without losing data.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE conversions ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'local';
ALTER TABLE conversions ADD COLUMN IF NOT EXISTS source_url TEXT;

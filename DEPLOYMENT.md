# Deployment Guide (Freelance Submission)

## Architecture
- Frontend: Vercel (folder `client`)
- Backend: Render (folder `backend`, Docker)
- Database: Neon PostgreSQL

## 1) Deploy Backend on Render
1. Push repo to GitHub (already done).
2. In Render: New -> Blueprint, select this repo.
3. Render reads `render.yaml` and creates `youtube-video-downloader-backend`.
4. Add env vars in Render service:
   - `DB_HOST`
   - `DB_PORT=5432`
   - `DB_NAME`
   - `DB_USER`
   - `DB_PASSWORD`
   - `DB_SSL=true`
5. Deploy service.
6. Open backend URL + `/health`.
   - Expected: JSON like `{ "status": "ok" ... }`

## 2) Prepare Neon Database
Run this SQL in Neon SQL editor:

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
  source VARCHAR(20) NOT NULL DEFAULT 'local',
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  download_url TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversions_status ON conversions(status);
CREATE INDEX IF NOT EXISTS idx_conversions_created_at ON conversions(created_at DESC);
```

## 3) Deploy Frontend on Vercel
1. In Vercel project settings, add environment variable:
   - `REACT_APP_API_URL=https://<your-render-backend>.onrender.com`
2. Redeploy Vercel project.

## 4) Quick Verification
1. Backend health: `https://<backend>/health` -> should return JSON.
2. Frontend opens without alerts.
3. Queue one YouTube video link.
4. Check `GET /conversions` on backend returns rows.

## 5) Common Fixes for "Network Error"
- `REACT_APP_API_URL` missing or wrong.
- Backend service sleeping/not deployed.
- Backend URL uses `http` instead of `https`.
- DB vars missing in Render.
- Frontend not redeployed after env var change.

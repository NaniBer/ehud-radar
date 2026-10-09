import pg from 'pg';
import type { Pool } from 'pg';

export function openDatabase(connectionString: string) {
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, max: 10 });
}

export async function migrateDatabase(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL UNIQUE CHECK (username = 'ehudaiuser'),
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);
    CREATE TABLE IF NOT EXISTS prospects (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('agency', 'production_company', 'filmmaker', 'creator', 'brand', 'education', 'community', 'other')),
      website TEXT NOT NULL DEFAULT '',
      website_key TEXT NOT NULL DEFAULT '',
      name_key TEXT NOT NULL,
      location_key TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      relevance TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      sources JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT prospects_name_location_unique UNIQUE (name_key, location_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prospects_website_unique ON prospects (website_key) WHERE website_key <> '';
    CREATE INDEX IF NOT EXISTS prospects_recent_idx ON prospects (updated_at DESC, id);
    CREATE TABLE IF NOT EXISTS discovery_runs (
      id UUID PRIMARY KEY,
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL,
      result_limit INTEGER NOT NULL CHECK (result_limit BETWEEN 1 AND 10),
      provider TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
      error_message TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS discovery_runs_recent_idx ON discovery_runs (created_at DESC, id);
    CREATE UNIQUE INDEX IF NOT EXISTS discovery_one_running_idx ON discovery_runs (status) WHERE status = 'running';
    CREATE TABLE IF NOT EXISTS discovery_candidates (
      id UUID PRIMARY KEY,
      run_id UUID NOT NULL REFERENCES discovery_runs(id),
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      url_key TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL,
      dismissed BOOLEAN NOT NULL DEFAULT FALSE,
      saved_prospect_id UUID REFERENCES prospects(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (run_id, url_key)
    );
    CREATE INDEX IF NOT EXISTS discovery_candidates_run_idx ON discovery_candidates (run_id, position);
    CREATE TABLE IF NOT EXISTS discovery_assessments (
      id UUID PRIMARY KEY,
      candidate_id UUID NOT NULL REFERENCES discovery_candidates(id),
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
      result JSONB,
      error_message TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS discovery_assessment_running_idx ON discovery_assessments (candidate_id) WHERE status = 'running';
    CREATE TABLE IF NOT EXISTS outreach_state (
      prospect_id UUID PRIMARY KEY REFERENCES prospects(id),
      research_summary TEXT NOT NULL DEFAULT '',
      contact_role TEXT NOT NULL DEFAULT '',
      contact_source_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','replied','follow_up','closed')),
      follow_up_date DATE,
      notes TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS outreach_drafts (
      id UUID PRIMARY KEY,
      prospect_id UUID NOT NULL REFERENCES prospects(id),
      channel TEXT NOT NULL CHECK (channel IN ('email','linkedin')),
      purpose TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL CHECK (origin IN ('manual','ai')),
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      input_key TEXT NOT NULL DEFAULT '',
      source_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      caveats JSONB NOT NULL DEFAULT '[]'::jsonb,
      model TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      prospect_version INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS outreach_drafts_prospect_idx ON outreach_drafts(prospect_id,created_at DESC,id);
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_cached_draft_idx ON outreach_drafts(prospect_id,input_key) WHERE origin='ai' AND status IN ('running','completed');
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_one_running_idx ON outreach_drafts(status) WHERE status='running';
  `);
}

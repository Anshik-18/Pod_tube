import { readFile } from 'fs/promises';
import path from 'path';
import { getDbPool } from './client';

/** Base schema (CREATE ... IF NOT EXISTS), so a brand-new database works on first start. */
const SCHEMA_FILE = path.join(process.cwd(), 'lib', 'db', 'schema.sql');

/**
 * Idempotent, additive schema migrations. Run once at server startup so that
 * request handlers never have to issue DDL on the hot path.
 */
const MIGRATIONS: string[] = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMP WITH TIME ZONE`,
  `CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(password_reset_token)`,

  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title VARCHAR(255)`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS markers JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS participant_names JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_chunks INTEGER`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recording_duration INTEGER`,

  `ALTER TABLE episodes ADD COLUMN IF NOT EXISTS description TEXT`,
  `ALTER TABLE episodes ADD COLUMN IF NOT EXISTS trim_settings JSONB`,

  `ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0`,

  `ALTER TABLE uploads ADD COLUMN IF NOT EXISTS total_chunks INTEGER`,
  `ALTER TABLE uploads ADD COLUMN IF NOT EXISTS recording_duration INTEGER`,
  `ALTER TABLE uploads ADD COLUMN IF NOT EXISTS recording_started_at TIMESTAMP WITH TIME ZONE`,
  `ALTER TABLE uploads ADD COLUMN IF NOT EXISTS recording_ended_at TIMESTAMP WITH TIME ZONE`,

  `CREATE TABLE IF NOT EXISTS recording_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    participant_type VARCHAR(50) NOT NULL,
    chunk_index INTEGER NOT NULL,
    storage_key VARCHAR(500) NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    etag VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(session_id, participant_type, chunk_index)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recording_chunks_session ON recording_chunks(session_id, participant_type)`,
  `CREATE INDEX IF NOT EXISTS idx_recording_chunks_status ON recording_chunks(status)`,
];

let migrated: Promise<void> | null = null;

export function runMigrations(): Promise<void> {
  if (!migrated) {
    migrated = (async () => {
      const pool = getDbPool();
      await pool.query(await readFile(SCHEMA_FILE, 'utf8'));
      for (const sql of MIGRATIONS) {
        await pool.query(sql);
      }

      // One episode per session. Fails harmlessly if legacy duplicates exist.
      try {
        await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_session_id ON episodes(session_id)');
      } catch (err) {
        console.warn('[Migrate] Could not create unique episodes(session_id) index:', (err as Error).message);
      }
      // At most one queued/running processing job per episode (backstop against races).
      try {
        await pool.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_jobs_one_active ON processing_jobs(episode_id) WHERE status IN ('pending', 'processing')`
        );
      } catch (err) {
        console.warn('[Migrate] Could not create single-active-job index:', (err as Error).message);
      }
      console.log(`[Migrate] Schema up to date (${MIGRATIONS.length} checks)`);
    })().catch((err) => {
      migrated = null;
      throw err;
    });
  }
  return migrated;
}

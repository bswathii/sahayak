// db.js — SQLite persistence (better-sqlite3). Single file database, WAL mode.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });

export const db = new Database(path.resolve(config.databasePath));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS volunteers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',        -- JSON array of subject tags
  languages TEXT NOT NULL DEFAULT '[]',     -- JSON array of language codes
  availability TEXT NOT NULL DEFAULT '{}',  -- JSON {days:[], from:"HH:MM", to:"HH:MM"}
  max_concurrent INTEGER NOT NULL DEFAULT 2,
  active_sessions INTEGER NOT NULL DEFAULT 0,
  is_seed INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'kn',
  lesson_id TEXT,
  content_version INTEGER,
  status TEXT NOT NULL DEFAULT 'OPEN',
  student_device TEXT,
  volunteer_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_device TEXT,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (session_id, seq),
  UNIQUE (session_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);

-- Every lifecycle transition is persisted, never overwritten.
CREATE TABLE IF NOT EXISTS session_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  volunteer_id TEXT NOT NULL,
  reasons TEXT NOT NULL,
  breakdown TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  source TEXT NOT NULL,          -- 'ai' | 'deterministic'
  model TEXT,
  ai_status TEXT NOT NULL,       -- 'AI_GENERATED' | 'FALLBACK_DETERMINISTIC'
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  event_id TEXT,
  seq INTEGER
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  operation TEXT NOT NULL,       -- translate | summarize_handoff | coaching_tips
  outcome TEXT NOT NULL,         -- success | failure | skipped | fallback
  latency_ms INTEGER,
  detail TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assessment_items (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  objective TEXT,
  stage TEXT NOT NULL DEFAULT 'pre',
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  correct_index INTEGER,
  explanation TEXT
);

CREATE TABLE IF NOT EXISTS assessment_responses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  item_id TEXT NOT NULL,
  response TEXT NOT NULL,
  is_correct INTEGER,
  event_id TEXT,
  seq INTEGER,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS replay_tests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  requested_since INTEGER NOT NULL,
  replayed INTEGER NOT NULL,
  duplicates_dropped INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
`);

// ---------- seed volunteers (realistic, clearly seeded) ----------
const now = Date.now();
const seed = [
  {
    id: 'vol-ananya',
    name: 'Ananya R.',
    skills: ['physics', 'mechanics', 'design'],
    languages: ['kn', 'en', 'hi'],
    availability: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '16:00', to: '19:00' },
  },
  {
    id: 'vol-vikram',
    name: 'Vikram S.',
    skills: ['mathematics', 'physics'],
    languages: ['en', 'hi'],
    availability: { days: ['mon', 'wed', 'sat'], from: '17:00', to: '20:00' },
  },
  {
    id: 'vol-meghana',
    name: 'Meghana K.',
    skills: ['design', 'arts', 'mechanics'],
    languages: ['kn', 'en'],
    availability: { days: ['tue', 'thu', 'sat'], from: '15:00', to: '18:00' },
  },
  {
    id: 'vol-farhan',
    name: 'Farhan A.',
    skills: ['electronics', 'mathematics'],
    languages: ['en', 'hi'],
    availability: { days: ['wed', 'fri', 'sun'], from: '18:00', to: '21:00' },
  },
  {
    id: 'vol-lakshmi',
    name: 'Lakshmi N.',
    skills: ['physics', 'mechanics', 'mathematics'],
    languages: ['kn', 'hi', 'en'],
    availability: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], from: '09:00', to: '12:00' },
  },
];

const insertVolunteer = db.prepare(`
  INSERT INTO volunteers (id, name, skills, languages, availability, max_concurrent, active_sessions, is_seed, created_at)
  VALUES (@id, @name, @skills, @languages, @availability, 2, 0, 1, @created_at)
  ON CONFLICT(id) DO NOTHING
`);
for (const v of seed) {
  insertVolunteer.run({
    id: v.id,
    name: v.name,
    skills: JSON.stringify(v.skills),
    languages: JSON.stringify(v.languages),
    availability: JSON.stringify(v.availability),
    created_at: now,
  });
}

export function closeDb() {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

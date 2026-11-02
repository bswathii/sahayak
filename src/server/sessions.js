// sessions.js — session codes, session lifecycle, event persistence and
// transparent volunteer matching. All functions are synchronous (better-sqlite3).
import crypto from 'node:crypto';
import { db } from './db.js';
import { envelope } from './protocol.js';

export const STATES = ['OPEN', 'OFFERED', 'ACCEPTED', 'SESSION', 'FEEDBACK', 'CLOSED'];

// Invalid transitions are refused rather than silently coerced.
const ALLOWED = {
  OPEN: ['OFFERED'],
  OFFERED: ['ACCEPTED', 'OPEN'],
  ACCEPTED: ['SESSION', 'OPEN'],
  SESSION: ['FEEDBACK'],
  FEEDBACK: ['CLOSED'],
  CLOSED: [],
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 ambiguity

export const newId = () => crypto.randomUUID();

export function newSessionCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!db.prepare('SELECT 1 FROM sessions WHERE code = ?').get(code)) return code;
  }
  throw new Error('could not allocate session code');
}

export function createSession({ topic, language = 'kn', lessonId = null, contentVersion = null }) {
  const session = {
    id: newId(),
    code: newSessionCode(),
    topic: String(topic || 'Temporary test lesson').slice(0, 160),
    language: /^[a-z]{2}$/.test(language) ? language : 'kn',
    lesson_id: lessonId,
    content_version: contentVersion,
    status: 'OPEN',
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO sessions (id, code, topic, language, lesson_id, content_version, status, created_at)
     VALUES (@id, @code, @topic, @language, @lesson_id, @content_version, @status, @created_at)`
  ).run(session);
  return session;
}

export function getSessionByCode(code) {
  if (typeof code !== 'string') return null;
  return db.prepare('SELECT * FROM sessions WHERE code = ?').get(code.toUpperCase()) || null;
}

export function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

export function setStudentDevice(sessionId, deviceId) {
  db.prepare('UPDATE sessions SET student_device = ? WHERE id = ? AND student_device IS NULL').run(
    deviceId,
    sessionId
  );
}

export function lastSeq(sessionId) {
  const row = db.prepare('SELECT MAX(seq) AS s FROM events WHERE session_id = ?').get(sessionId);
  return row?.s || 0;
}

/**
 * Append an event to a session's ordered log. Assigns the next sequence number.
 * Duplicate eventIds (retries after a dropped ack) return the stored event and
 * do not consume a sequence number.
 */
export function appendEvent({ sessionId, type, eventId, role, deviceId, payload, ts = Date.now() }) {
  const existing = db
    .prepare('SELECT * FROM events WHERE session_id = ? AND event_id = ?')
    .get(sessionId, eventId);
  if (existing) {
    return { duplicate: true, event: rowToEnvelope(existing) };
  }
  const seq = lastSeq(sessionId) + 1;
  try {
    db.prepare(
      `INSERT INTO events (session_id, seq, event_id, type, actor_role, actor_device, ts, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, seq, eventId, type, role, deviceId || null, ts, JSON.stringify(payload));
  } catch (err) {
    // Socket race on the same sequence number: retry once with a fresh number.
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      const retrySeq = lastSeq(sessionId) + 1;
      db.prepare(
        `INSERT INTO events (session_id, seq, event_id, type, actor_role, actor_device, ts, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(sessionId, retrySeq, eventId, type, role, deviceId || null, ts, JSON.stringify(payload));
      return { duplicate: false, event: readEvent(sessionId, retrySeq) };
    }
    throw err;
  }
  return { duplicate: false, event: readEvent(sessionId, seq) };
}

function rowToEnvelope(row) {
  return envelope({
    type: row.type,
    eventId: row.event_id,
    sessionId: row.session_id,
    seq: row.seq,
    role: row.actor_role,
    deviceId: row.actor_device,
    ts: row.ts,
    payload: JSON.parse(row.payload),
  });
}

function readEvent(sessionId, seq) {
  const row = db.prepare('SELECT * FROM events WHERE session_id = ? AND seq = ?').get(sessionId, seq);
  return rowToEnvelope(row);
}

export function eventsSince(sessionId, since, limit = 2000) {
  return db
    .prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(sessionId, Number(since) || 0, limit)
    .map(rowToEnvelope);
}

export function eventsForSession(sessionId, limit = 5000) {
  return db
    .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC LIMIT ?')
    .all(sessionId, limit)
    .map(rowToEnvelope);
}

/**
 * Persist and apply a lifecycle transition.
 * @throws {{code:string,message:string}} on an invalid transition
 */
export function transition({ sessionId, toState, actor, meta = {}, eventId = newId(), deviceId = null }) {
  const session = getSession(sessionId);
  if (!session) throw { code: 'no_session', message: 'session not found' };
  if (!STATES.includes(toState)) throw { code: 'bad_state', message: 'unknown state' };
  const from = session.status;
  if (!ALLOWED[from].includes(toState)) {
    throw { code: 'invalid_transition', message: `cannot move ${from} to ${toState}` };
  }

  const { event } = appendEvent({
    sessionId,
    type: 'session.state',
    eventId,
    role: actor,
    deviceId,
    payload: { from, to: toState, meta },
  });

  db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(toState, sessionId);
  if (toState === 'ACCEPTED' && meta.volunteerId) {
    db.prepare('UPDATE sessions SET volunteer_id = ? WHERE id = ?').run(meta.volunteerId, sessionId);
  }
  if (toState === 'SESSION') {
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ? AND started_at IS NULL').run(
      Date.now(),
      sessionId
    );
  }
  if (toState === 'CLOSED') {
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(Date.now(), sessionId);
  }
  db.prepare(
    `INSERT INTO session_transitions (session_id, from_state, to_state, actor, event_id, seq, ts, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, from, toState, actor, event.eventId, event.seq, event.ts, JSON.stringify(meta));

  return event;
}

export function transitionsFor(sessionId) {
  return db
    .prepare('SELECT * FROM session_transitions WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId)
    .map((r) => ({ ...r, meta: JSON.parse(r.meta || '{}') }));
}

// ---------------- volunteer matching ----------------

// Topic keyword → skill tag. Deliberately simple and explainable; no opaque model.
const TOPIC_SKILL_HINTS = [
  ['force', 'physics'],
  ['load', 'physics'],
  ['support', 'physics'],
  ['lever', 'mechanics'],
  ['motion', 'mechanics'],
  ['motor', 'mechanics'],
  ['structure', 'mechanics'],
  ['angle', 'mathematics'],
  ['measure', 'mathematics'],
  ['number', 'mathematics'],
  ['design', 'design'],
  ['draw', 'design'],
  ['shape', 'design'],
  ['circuit', 'electronics'],
  ['sensor', 'electronics'],
];

function topicSkills(topic) {
  const t = String(topic || '').toLowerCase();
  const hit = new Set();
  for (const [kw, skill] of TOPIC_SKILL_HINTS) if (t.includes(kw)) hit.add(skill);
  return hit;
}

function availabilityNow(availability) {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const now = new Date();
  const day = days[now.getDay()];
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const inWindow = availability?.days?.includes(day) && hhmm >= availability.from && hhmm <= availability.to;
  return { inWindow, day, time: hhmm };
}

/**
 * Rank volunteers with an explicit, inspectable breakdown.
 * Weights: language 40, subject 35, availability 15, load 10.
 */
export function matchVolunteers(session, limit = 4) {
  const volunteers = db.prepare('SELECT * FROM volunteers WHERE is_seed = 1').all();
  const wantedSkills = topicSkills(session.topic);
  const results = volunteers.map((v) => {
    const skills = JSON.parse(v.skills);
    const languages = JSON.parse(v.languages);
    const availability = JSON.parse(v.availability);
    const reasons = [];

    const langScore = languages.includes(session.language) ? 40 : 0;
    reasons.push(
      languages.includes(session.language)
        ? `Speaks ${session.language === 'kn' ? 'Kannada' : session.language.toUpperCase()}, the student's preferred language`
        : `Does not speak ${session.language === 'kn' ? 'Kannada' : session.language.toUpperCase()}`
    );

    const matchedSkills = [...wantedSkills].filter((s) => skills.includes(s));
    const skillScore = wantedSkills.size ? Math.round((matchedSkills.length / wantedSkills.size) * 35) : 15;
    reasons.push(
      matchedSkills.length
        ? `Subject match: ${matchedSkills.join(', ')}`
        : `No direct subject tag match for "${session.topic}"`
    );

    const avail = availabilityNow(availability);
    const availScore = avail.inWindow ? 15 : 4;
    reasons.push(
      avail.inWindow
        ? `Available now (${availability.from}-${availability.to})`
        : `Outside stated hours (${availability.from}-${availability.to})`
    );

    const loadScore = Math.max(0, 10 - v.active_sessions * 5);
    reasons.push(
      v.active_sessions === 0
        ? 'Currently unassigned'
        : `Currently on ${v.active_sessions} session(s)`
    );

    const score = langScore + skillScore + availScore + loadScore;
    return {
      volunteerId: v.id,
      name: v.name,
      skills,
      languages,
      availability,
      score,
      breakdown: { language: langScore, subject: skillScore, availability: availScore, load: loadScore },
      reasons,
    };
  });

  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return results.slice(0, limit);
}

export function recordMatch(sessionId, candidate) {
  db.prepare(
    `INSERT INTO matches (id, session_id, volunteer_id, reasons, breakdown, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    newId(),
    sessionId,
    candidate.volunteerId,
    JSON.stringify(candidate.reasons),
    JSON.stringify(candidate.breakdown),
    Date.now()
  );
}

export function interactionResponses(sessionId) {
  const rows = db
    .prepare(
      `SELECT seq, event_id, ts, actor_role, payload FROM events
       WHERE session_id = ? AND type = 'student.observation_submitted' ORDER BY seq ASC`
    )
    .all(sessionId);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

export function textEvents(sessionId) {
  const rows = db
    .prepare(
      `SELECT seq, event_id, ts, actor_role, payload FROM events
       WHERE session_id = ? AND type = 'message.created' ORDER BY seq ASC`
    )
    .all(sessionId);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

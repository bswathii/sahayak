// relay.js — WebSocket event relay.
// Responsibilities: handshake, join, dedupe, sequence assignment, ordered replay,
// fan-out, presence and (optionally) an application-level payload cap.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { log } from './log.js';
import {
  PROTOCOL_VERSION,
  LIMITS,
  PERSISTED_TYPES,
  ProtocolError,
  frameBytes,
  validateInbound,
} from './protocol.js';
import { db } from './db.js';
import {
  appendEvent,
  eventsSince,
  getSession,
  getSessionByCode,
  lastSeq,
  setStudentDevice,
  STATES,
  newId,
} from './sessions.js';
import { defaultLesson, getLesson } from './lessons.js';
import { translate } from './translation.js';
import { AIUnavailableError } from './ai/provider.js';

const HEARTBEAT_MS = 30_000;
const MAX_INFLIGHT_PER_SOCKET = 120;

/** Sessions that currently have at least one socket attached. */
const rooms = new Map(); // sessionId -> Set<conn>

function send(conn, obj) {
  if (conn.socket.readyState !== conn.socket.OPEN) return 0;
  let data;
  try {
    data = JSON.stringify(obj);
  } catch {
    return 0;
  }
  conn.socket.send(data);
  const bytes = Buffer.byteLength(data, 'utf8');
  conn.sentBytes += bytes;
  conn.sentMessages += 1;
  return bytes;
}

function errorFrame(conn, code, message, eventId = null) {
  send(conn, { t: 'error', code, message, eventId, v: PROTOCOL_VERSION });
}

function broadcast(sessionId, obj, exceptConn = null) {
  const set = rooms.get(sessionId);
  if (!set) return;
  for (const conn of set) {
    if (conn !== exceptConn) send(conn, obj);
  }
}

/**
 * Application-level payload cap (Section 6E experiment).
 * Throttles Sahayak event frames per session; it is NOT network shaping and must
 * never be reported as proof that the product runs at 1 kbps.
 */
function createCap(sessionId) {
  if (!(config.payloadCapBps > 0)) return null;
  return {
    sessionId,
    queue: [],
    budget: 0,
    last: Date.now(),
    dropped: 0,
    timer: setInterval(() => {
      const state = caps.get(sessionId);
      if (!state) return;
      const now = Date.now();
      state.budget = Math.min(
        config.payloadCapBps,
        state.budget + ((now - state.last) / 1000) * config.payloadCapBps
      );
      state.last = now;
      while (state.queue.length) {
        const item = state.queue[0];
        const size = Buffer.byteLength(JSON.stringify(item.obj), 'utf8');
        if (size > state.budget) break;
        state.budget -= size;
        state.queue.shift();
        broadcast(item.sessionId, item.obj);
      }
    }, 100),
  };
}

const caps = new Map();
function sendWithCap(sessionId, obj) {
  if (!(config.payloadCapBps > 0)) {
    broadcast(sessionId, obj);
    return;
  }
  let cap = caps.get(sessionId);
  if (!cap) {
    cap = createCap(sessionId);
    caps.set(sessionId, cap);
  }
  if (cap.queue.length > 400) {
    cap.dropped += 1;
    return;
  }
  cap.queue.push({ sessionId, obj });
}

function presenceRoom(sessionId) {
  const set = rooms.get(sessionId) || new Set();
  const byRole = { student: 0, volunteer: 0 };
  for (const c of set) if (byRole[c.role] !== undefined) byRole[c.role] += 1;
  return {
    t: 'presence',
    sessionId,
    connected: set.size,
    students: byRole.student,
    volunteers: byRole.volunteer,
    seq: lastSeq(sessionId),
    ts: Date.now(),
  };
}

function attach(sessionId, conn) {
  let set = rooms.get(sessionId);
  if (!set) {
    set = new Set();
    rooms.set(sessionId, set);
  }
  set.add(conn);
  conn.sessionId = sessionId;
}

function detach(conn) {
  if (!conn.sessionId) return;
  const set = rooms.get(conn.sessionId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) {
    rooms.delete(conn.sessionId);
    const cap = caps.get(conn.sessionId);
    if (cap) clearInterval(cap.timer);
    caps.delete(conn.sessionId);
    return;
  }
  broadcast(conn.sessionId, presenceRoom(conn.sessionId));
}

function sessionSnapshot(session) {
  const lesson = (session.lesson_id && getLesson(session.lesson_id)) || defaultLesson();
  return {
    t: 'snapshot',
    session: {
      id: session.id,
      code: session.code,
      topic: session.topic,
      language: session.language,
      status: session.status,
      lessonId: session.lesson_id || lesson?.id || null,
      contentVersion: session.content_version ?? lesson?.contentVersion ?? null,
      startedAt: session.started_at,
      endedAt: session.ended_at,
    },
    lesson,
    lessonLabel: lesson?.label || null,
    seq: lastSeq(session.id),
    serverTime: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
  };
}

function handleHello(conn, msg) {
  if (msg.v !== PROTOCOL_VERSION) {
    errorFrame(conn, 'bad_version', `protocol version ${PROTOCOL_VERSION} required`);
    return;
  }
  const role = msg.role === 'volunteer' || msg.role === 'student' ? msg.role : null;
  if (!role) return errorFrame(conn, 'bad_role', 'role must be student or volunteer');

  const code = String(msg.code || '').trim().toUpperCase();
  const session = getSessionByCode(code);
  // A session code is a join handle, not authentication. Documented as such.
  if (!session) return errorFrame(conn, 'no_session', 'unknown session code');

  const deviceId = /^[A-Za-z0-9_-]{6,64}$/.test(String(msg.deviceId || ''))
    ? String(msg.deviceId)
    : `dev-${crypto.randomBytes(6).toString('hex')}`;

  conn.role = role;
  conn.deviceId = deviceId;
  conn.sessionCode = session.code;

  if (role === 'student' && !session.student_device) {
    setStudentDevice(session.id, deviceId);
  }

  attach(session.id, conn);

  const since = Number.isInteger(msg.since) ? Math.max(0, msg.since) : 0;
  const missed = since > 0 ? eventsSince(session.id, since) : eventsSince(session.id, 0);

  send(conn, {
    t: 'hello.ok',
    role,
    deviceId,
    sessionId: session.id,
    code: session.code,
    protocolVersion: PROTOCOL_VERSION,
    serverTime: Date.now(),
    lastSeq: lastSeq(session.id),
  });
  send(conn, sessionSnapshot(getSession(session.id) || session));
  if (missed.length) send(conn, { t: 'replay', events: missed });
  send(conn, presenceRoom(session.id));
  broadcast(session.id, presenceRoom(session.id), conn);

  // Join is part of the session history: a second volunteer can see who was here.
  const joined = appendEvent({
    sessionId: session.id,
    type: 'session.joined',
    eventId: newId(),
    role,
    deviceId,
    payload: { role, resumed: since > 0, replayed: missed.length },
  });
  if (!joined.duplicate) broadcast(session.id, { t: 'event', event: joined.event }, conn);

  log.info('ws join', {
    sessionId: session.id,
    role,
    deviceId,
    replayed: missed.length,
    since,
  });
}

function ack(conn, event) {
  send(conn, { t: 'ack', eventId: event.eventId, seq: event.seq });
}

async function handleEvent(conn, raw, deps) {
  let event;
  try {
    event = validateInbound(raw);
  } catch (err) {
    if (err instanceof ProtocolError) {
      return errorFrame(conn, err.code, err.message, raw?.eventId || null);
    }
    throw err;
  }

  const sessionId = conn.sessionId;
  if (!sessionId) return errorFrame(conn, 'not_joined', 'send hello first');

  const session = getSession(sessionId);
  if (!session) return errorFrame(conn, 'no_session', 'session is gone');
  if (session.status === 'CLOSED') {
    return errorFrame(conn, 'session_closed', 'this session is closed', event.eventId);
  }

  // Role guards: the volunteer draws and answers; the student owns the pathway.
  if ((event.type === 'drawing.stroke' || event.type === 'drawing.cleared') && conn.role !== 'volunteer') {
    return errorFrame(conn, 'role_forbidden', 'only the volunteer can draw on the board', event.eventId);
  }
  if ((event.type.startsWith('student.') || event.type.startsWith('activity.')) && conn.role !== 'student') {
    return errorFrame(conn, 'role_forbidden', 'only the student can record pathway work', event.eventId);
  }

  // Stage IDs must exist in the session's activity pack; a typo is a rejected
  // event, not a silently stored one.
  if (event.payload.stageId) {
    const pack = (session.lesson_id && getLesson(session.lesson_id)) || defaultLesson();
    const ids = (pack?.stages || []).map((s) => s.id);
    if (ids.length && !ids.includes(event.payload.stageId)) {
      return errorFrame(conn, 'unknown_stage', `stage ${event.payload.stageId} is not in this activity`, event.eventId);
    }
  }

  if (event.type === 'replay.request') {
    return sendReplay(conn, session, event);
  }

  if (event.type === 'measure.ping') {
    // Ephemeral by design: never persisted, never replayed.
    return send(conn, {
      t: 'pong',
      clientTs: event.payload.clientTs,
      serverTime: Date.now(),
      seq: lastSeq(sessionId),
      eventId: event.eventId,
    });
  }

  const { duplicate, event: stored } = appendEvent({
    sessionId,
    type: event.type,
    eventId: event.eventId,
    role: conn.role,
    deviceId: conn.deviceId,
    payload: event.payload,
  });

  if (duplicate) {
    // Re-delivery of an already stored event: ack it, do not fan it out again.
    ack(conn, stored);
    return send(conn, { t: 'duplicate', eventId: stored.eventId, seq: stored.seq });
  }

  ack(conn, stored);
  sendWithCap(sessionId, { t: 'event', event: stored });

  if (event.type === 'message.created') {
    // The message has already been relayed. Translation is a later, optional event.
    void emitTranslation(sessionId, stored, deps).catch((err) =>
      log.warn('translation pipeline error', { reason: err.message })
    );
  }
}

/**
 * Explicit replay: the client asks for everything after the last seq it holds.
 * Recorded in replay_tests so reconnection/recovery can be verified after the fact.
 */
function sendReplay(conn, session, event) {
  const since = event.payload.since;
  const missed = eventsSince(session.id, since);
  send(conn, {
    t: 'replay.response',
    since,
    count: missed.length,
    events: missed,
    lastSeq: lastSeq(session.id),
    ts: Date.now(),
  });
  db.prepare(
    'INSERT INTO replay_tests (id, session_id, requested_since, replayed, duplicates_dropped, ts) VALUES (?,?,?,?,?,?)'
  ).run(newId(), session.id, since, missed.length, 0, Date.now());
  log.info('replay served', { sessionId: session.id, since, replayed: missed.length });
}

async function emitTranslation(sessionId, messageEvent, deps) {
  const started = Date.now();
  const { text, targetLang } = messageEvent.payload;
  let result;
  try {
    result = await translate({
      text,
      lang: targetLang,
      sessionId,
      provider: deps.provider,
    });
  } catch (err) {
    log.warn('translation failed', { reason: err.message });
    result = { translation: null, status: 'FALLBACK', source: 'none', terms: [] };
  }

  const payload = {
    forEventId: messageEvent.eventId,
    forSeq: messageEvent.seq,
    lang: targetLang,
    text,
    translation: result.translation,
    status: result.status,
    source: result.source,
    terms: (result.terms || []).map((t) => ({ en: t.en, tr: t.tr, status: t.status })),
    reason: result.reason || null,
    model: result.model || null,
    latencyMs: Date.now() - started,
  };

  const { event } = appendEvent({
    sessionId,
    type: 'message.translation',
    eventId: newId(),
    role: 'server',
    deviceId: 'server',
    payload,
  });

  sendWithCap(sessionId, { t: 'event', event });
  log.info('translation emitted', {
    sessionId,
    status: payload.status,
    source: payload.source,
    latencyMs: payload.latencyMs,
  });
}

export function createRelay(server, deps) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: LIMITS.maxFrameBytes,
    perMessageDeflate: false, // compression costs CPU and obscures payload measurement
  });

  wss.on('connection', (socket) => {
    const conn = {
      socket,
      role: null,
      deviceId: null,
      sessionId: null,
      alive: true,
      sentBytes: 0,
      sentMessages: 0,
      inflight: 0,
      windowStart: Date.now(),
      windowCount: 0,
      interactionWindowStart: Date.now(),
      interactionCount: 0,
    };

    socket.on('pong', () => {
      // The heartbeat below checks socket.__alive, so it has to be set here.
      // Leaving it false terminated healthy connections every HEARTBEAT_MS.
      socket.__alive = true;
      conn.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return errorFrame(conn, 'bad_frame', 'binary frames are not supported');

      // Simple flood guard: a socket may not exceed a steady message rate.
      const now = Date.now();
      if (now - conn.windowStart > 10_000) {
        conn.windowStart = now;
        conn.windowCount = 0;
      }
      conn.windowCount += 1;
      if (conn.windowCount > MAX_INFLIGHT_PER_SOCKET) {
        return errorFrame(conn, 'rate_limited', 'too many messages');
      }

      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return errorFrame(conn, 'bad_json', 'frame is not valid JSON');
      }

      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
        return errorFrame(conn, 'bad_frame', 'expected {t, ...}');
      }

      try {
        if (msg.t === 'hello') return handleHello(conn, msg);
        if (msg.t === 'ping') {
          return send(conn, { t: 'pong', clientTs: Number(msg.clientTs) || 0, serverTime: Date.now() });
        }
        if (msg.t === 'bye') return socket.close(1000, 'client closed');

        if (msg.t === 'send') {
          const type = msg.event?.type;
          if (type === 'student.observation_submitted') {
            if (now - conn.interactionWindowStart > 60_000) {
              conn.interactionWindowStart = now;
              conn.interactionCount = 0;
            }
            conn.interactionCount += 1;
            if (conn.interactionCount > LIMITS.maxInteractionsPerMinute) {
              return errorFrame(conn, 'rate_limited', 'too many observations', msg.event?.eventId);
            }
          }
          return void handleEvent(conn, msg.event, deps).catch((err) => {
            log.error('event handling failed', { reason: err.message });
            errorFrame(conn, 'internal', 'event could not be processed', msg.event?.eventId);
          });
        }

        return errorFrame(conn, 'unknown_frame', `unknown frame type "${msg.t}"`);
      } catch (err) {
        log.error('ws message failed', { reason: err.message });
        errorFrame(conn, 'internal', 'request failed');
      }
    });

    socket.on('close', () => {
      if (conn.sessionId) {
        detach(conn);
        log.info('ws leave', { sessionId: conn.sessionId, role: conn.role });
      }
    });

    socket.on('error', (err) => log.warn('ws socket error', { reason: err.message }));

    send(conn, {
      t: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      serverTime: Date.now(),
      heartbeatMs: HEARTBEAT_MS,
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.__alive === false) {
        socket.terminate();
        continue;
      }
      socket.__alive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));

  return {
    wss,
    close() {
      clearInterval(heartbeat);
      for (const cap of caps.values()) clearInterval(cap.timer);
      caps.clear();
      wss.close();
    },
    stats() {
      return {
        connections: wss.clients.size,
        rooms: rooms.size,
      };
    },
  };
}

export const relayHelpers = { states: STATES, frameBytes };

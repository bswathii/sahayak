// protocol.js — versioned event protocol. Single source of truth for event
// shapes, validation limits and ordering rules. Mirrors API_CONTRACTS.md.
import { config } from './config.js';

export const PROTOCOL_VERSION = config.protocolVersion;

/**
 * The ten-stage learning pathway is a platform concept, not activity content:
 * the pack supplies the prompts, this list supplies the order and the IDs.
 */
export const STAGES = [
  { id: 'choose', key: 'CHOOSE' },
  { id: 'understand', key: 'UNDERSTAND' },
  { id: 'question', key: 'QUESTION' },
  { id: 'predict', key: 'PREDICT' },
  { id: 'plan', key: 'PLAN' },
  { id: 'build', key: 'BUILD' },
  { id: 'test', key: 'TEST' },
  { id: 'explain', key: 'EXPLAIN' },
  { id: 'improve', key: 'IMPROVE' },
  { id: 'reflect', key: 'REFLECT' },
];

export const STAGE_IDS = STAGES.map((s) => s.id);

// Event types a client may send. Everything else is rejected.
export const CLIENT_EVENT_TYPES = [
  'message.created',
  'drawing.stroke',
  'drawing.cleared',
  'activity.selected',
  'activity.stage_changed',
  'student.question_submitted',
  'student.prediction_submitted',
  'student.plan_submitted',
  'student.drawing_submitted',
  'student.build_started',
  'student.observation_submitted',
  'student.explanation_submitted',
  'student.improvement_submitted',
  'student.reflection_submitted',
  'replay.request',
  'measure.ping',
];

// Events the server may generate and persist.
export const SERVER_EVENT_TYPES = [
  'message.translation',
  'session.created',
  'session.joined',
  'session.state',
  'handoff.created',
  'presence',
];

// Event types that are persisted and replayed on reconnection.
// replay.request / replay.response / measure.ping are deliberately absent:
// they are transport control, not classroom history.
export const PERSISTED_TYPES = new Set([
  'message.created',
  'message.translation',
  'drawing.stroke',
  'drawing.cleared',
  'activity.selected',
  'activity.stage_changed',
  'student.question_submitted',
  'student.prediction_submitted',
  'student.plan_submitted',
  'student.drawing_submitted',
  'student.build_started',
  'student.observation_submitted',
  'student.explanation_submitted',
  'student.improvement_submitted',
  'student.reflection_submitted',
  'session.created',
  'session.joined',
  'session.state',
  'handoff.created',
  'presence',
]);

// Reserved for a future hardware interface. NOT implemented (see API_CONTRACTS.md).
export const RESERVED_FUTURE_TYPES = ['device.status', 'device.command', 'device.ack'];

export const LIMITS = {
  maxFrameBytes: 8192, // inbound JSON frame
  maxTextChars: 500,
  maxPointsPerChunk: 240,
  maxStrokeChunks: 2000,
  maxPayloadFieldChars: 200,
  maxInteractionsPerMinute: 40,
};

const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const STROKE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const STAGE_RE = /^[a-z][a-z0-9-]{1,40}$/;
const ACTIVITY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// Translation states shown to the user. A translation may never upgrade itself:
// only a human review can promote UNVERIFIED to VERIFIED.
export const TRANSLATION_STATUS = {
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
  AI_TRANSLATION: 'AI_TRANSLATION',
  FALLBACK: 'FALLBACK',
  PENDING: 'PENDING',
};

export const INTERACTION_RESULTS = [
  'it_works',
  'it_does_not_work',
  'im_stuck',
  'need_help',
  'try_again',
];

// Human-facing labels for generic, activity-independent student observations.
export const INTERACTION_LABELS = {
  it_works: 'It works.',
  it_does_not_work: 'It does not work.',
  im_stuck: "I'm stuck.",
  need_help: 'I need help.',
  try_again: 'I want to try again.',
};

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Quantise normalised [0..1] coordinates to 4 decimals to keep frames small. */
const q = (n) => Math.round(Math.min(1, Math.max(0, Number(n))) * 10000) / 10000;

function validatePoints(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new ProtocolError('bad_points', 'points must be a non-empty array');
  }
  if (points.length > LIMITS.maxPointsPerChunk) {
    throw new ProtocolError('too_many_points', `max ${LIMITS.maxPointsPerChunk} points per chunk`);
  }
  return points.map((p) => {
    if (!Array.isArray(p) || p.length < 2) {
      throw new ProtocolError('bad_point', 'each point must be [x,y]');
    }
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ProtocolError('bad_point', 'coordinates must be finite numbers');
    }
    return [q(x), q(y)];
  });
}

/** Stroke payload, shared by the volunteer board and the student sketch. */
function strokePayload(p) {
  if (typeof p.strokeId !== 'string' || !STROKE_ID_RE.test(p.strokeId)) {
    throw new ProtocolError('bad_stroke_id', 'strokeId must be 4-64 chars of [A-Za-z0-9_-]');
  }
  const color = COLOR_RE.test(p.color) ? p.color : '#ffffff';
  const width = Number.isFinite(Number(p.width)) ? Math.min(24, Math.max(1, Number(p.width))) : 3;
  return {
    strokeId: p.strokeId,
    color,
    width,
    points: validatePoints(p.points),
    first: Boolean(p.first),
    last: Boolean(p.last),
  };
}

function stageId(p) {
  if (!isStr(p.stageId, 40) || !STAGE_RE.test(p.stageId)) {
    throw new ProtocolError('bad_stage', 'stageId is required');
  }
  return p.stageId;
}

function shortText(p, field, max = LIMITS.maxTextChars) {
  const value = typeof p[field] === 'string' ? p[field].trim() : '';
  if (!value) throw new ProtocolError(`empty_${field}`, `${field} is required`);
  if (value.length > max) throw new ProtocolError(`long_${field}`, `${field} is too long`);
  return value;
}

// Student submissions that carry a stage and a piece of their own text.
const TEXT_SUBMISSIONS = new Set([
  'student.question_submitted',
  'student.prediction_submitted',
  'student.plan_submitted',
  'student.explanation_submitted',
  'student.improvement_submitted',
  'student.reflection_submitted',
]);

/**
 * Validate an inbound client event.
 * @returns {{type:string, eventId:string, payload:object, clientSeq:number|null}}
 */
export function validateInbound(raw) {
  if (!isPlainObject(raw)) throw new ProtocolError('bad_frame', 'frame must be a JSON object');
  if (raw.v !== PROTOCOL_VERSION) {
    throw new ProtocolError('bad_version', `unsupported protocol version (expected ${PROTOCOL_VERSION})`);
  }
  if (typeof raw.type !== 'string' || !CLIENT_EVENT_TYPES.includes(raw.type)) {
    if (RESERVED_FUTURE_TYPES.includes(raw.type)) {
      throw new ProtocolError('reserved_type', 'hardware events are reserved and not implemented');
    }
    throw new ProtocolError('unknown_type', 'unknown event type');
  }
  if (typeof raw.eventId !== 'string' || !EVENT_ID_RE.test(raw.eventId)) {
    throw new ProtocolError('bad_event_id', 'eventId must be 8-64 chars of [A-Za-z0-9_-]');
  }
  if (raw.clientSeq !== undefined && !Number.isInteger(raw.clientSeq)) {
    throw new ProtocolError('bad_client_seq', 'clientSeq must be an integer');
  }
  const p = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainObject(p)) throw new ProtocolError('bad_payload', 'payload must be an object');

  let payload;
  switch (raw.type) {
    case 'message.created': {
      const text = shortText(p, 'text');
      const targetLang = isStr(p.targetLang, 8) ? p.targetLang : 'kn';
      if (!/^[a-z]{2}$/.test(targetLang)) {
        throw new ProtocolError('bad_lang', 'targetLang must be an ISO 639-1 code');
      }
      const sourceLang = isStr(p.sourceLang, 8) && /^[a-z]{2}$/.test(p.sourceLang) ? p.sourceLang : 'en';
      payload = { text, sourceLang, targetLang };
      break;
    }
    case 'drawing.stroke':
    case 'student.drawing_submitted':
      payload = strokePayload(p);
      break;
    case 'drawing.cleared':
      payload = {};
      break;
    case 'activity.selected': {
      if (!isStr(p.activityId, 64) || !ACTIVITY_RE.test(p.activityId)) {
        throw new ProtocolError('bad_activity', 'activityId is required');
      }
      payload = { activityId: p.activityId };
      break;
    }
    case 'activity.stage_changed':
      payload = { stageId: stageId(p) };
      break;
    case 'student.build_started':
      payload = { stageId: stageId(p) };
      break;
    case 'student.observation_submitted': {
      if (!INTERACTION_RESULTS.includes(p.result)) {
        throw new ProtocolError('bad_result', `result must be one of ${INTERACTION_RESULTS.join(', ')}`);
      }
      payload = {
        stageId: stageId(p),
        result: p.result,
        label: INTERACTION_LABELS[p.result],
        note: isStr(p.note, 200) ? p.note : null,
      };
      break;
    }
    case 'replay.request': {
      payload = { since: Number.isInteger(p.since) && p.since >= 0 ? p.since : 0 };
      break;
    }
    case 'measure.ping': {
      // Ephemeral: never persisted, never replayed.
      payload = { clientTs: Number(p.clientTs) || 0, sample: isStr(p.sample, 24) ? p.sample : null };
      break;
    }
    default: {
      if (TEXT_SUBMISSIONS.has(raw.type)) {
        payload = { stageId: stageId(p), text: shortText(p, 'text') };
        break;
      }
      throw new ProtocolError('unknown_type', 'unknown event type');
    }
  }

  return {
    type: raw.type,
    eventId: raw.eventId,
    clientSeq: Number.isInteger(raw.clientSeq) ? raw.clientSeq : null,
    payload,
  };
}

/**
 * Build the outbound server envelope.
 * eventId and seq are independent identifiers: eventId is generated once by the
 * sender for deduplication; seq is assigned once by the server for ordering.
 */
export function envelope({ type, eventId, sessionId, seq, role, deviceId, ts, payload }) {
  return {
    v: PROTOCOL_VERSION,
    type,
    eventId,
    sessionId,
    seq,
    actor: { role, deviceId },
    ts,
    payload,
  };
}

/** JSON byte length of a frame as the application counts it. */
export const frameBytes = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8');

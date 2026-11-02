// index.js — HTTP app + WebSocket relay bootstrap.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config, isAiConfigured } from './config.js';
import { log } from './log.js';
import { db } from './db.js';
import { geminiProvider } from './ai/gemini.js';
import { nullProvider } from './ai/provider.js';
import {
  STATES,
  createSession,
  getSession,
  getSessionByCode,
  matchVolunteers,
  recordMatch,
  transition,
  transitionsFor,
  eventsForSession,
  interactionResponses,
  newId,
} from './sessions.js';
import { listLessons, getLesson, defaultLesson, contentVersionToken } from './lessons.js';
import { createRelay } from './relay.js';
import { appendEvent } from './sessions.js';
import { generateHandoff, latestHandoff, coachingTips } from './handoff.js';
import { aiUsageStats, glossarySummary } from './translation.js';
import { PROTOCOL_VERSION, INTERACTION_LABELS, TRANSLATION_STATUS } from './protocol.js';

const provider = config.ai.provider === 'gemini' ? geminiProvider : nullProvider;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const startedAt = Date.now();

// ---------- request logging (structured, no student content) ----------
app.use((req, res, next) => {
  const begin = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - begin) / 1e6;
    if (req.path.startsWith('/api') || res.statusCode >= 400) {
      log.info('http', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms),
      });
    }
  });
  next();
});

// ---------- helpers ----------
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  if (err && err.code && err.message && !err.stack) {
    return fail(res, 400, err.code, err.message);
  }
  log.error('api failure', { reason: err.message, path: req.path });
  return fail(res, 500, 'internal', 'request failed');
});

const byCode = (req) => getSessionByCode(req.params.code);

function sessionSummary(session) {
  return {
    id: session.id,
    code: session.code,
    topic: session.topic,
    language: session.language,
    status: session.status,
    lessonId: session.lesson_id,
    contentVersion: session.content_version,
    createdAt: session.created_at,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    volunteerId: session.volunteer_id,
  };
}

// ---------- meta ----------
app.get('/health', (req, res) => {
  let dbOk = false;
  try {
    dbOk = db.prepare('SELECT 1 AS ok').get()?.ok === 1;
  } catch {
    dbOk = false;
  }
  const healthy = dbOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    protocolVersion: PROTOCOL_VERSION,
    database: dbOk ? 'ok' : 'unavailable',
    ai: {
      configured: isAiConfigured(),
      enabled: config.ai.enabled,
      provider: provider.name,
    },
    contentVersion: contentVersionToken(),
  });
});

app.get('/api/meta', (req, res) => {
  res.json({
    protocolVersion: PROTOCOL_VERSION,
    ai: {
      provider: provider.name,
      enabled: config.ai.enabled,
      configured: isAiConfigured(),
      model: config.ai.provider === 'gemini' && isAiConfigured() ? config.ai.model : null,
      // The browser never receives a key; this is only a state flag.
    },
    measurement: { payloadCapBps: config.payloadCapBps },
    states: STATES,
    translations: TRANSLATION_STATUS,
    interactions: INTERACTION_LABELS,
    glossaries: glossarySummary(),
    contentVersion: contentVersionToken(),
  });
});

// ---------- interface strings (cached by the service worker) ----------
let uiStrings = null;
app.get('/api/ui', (req, res) => {
  if (!uiStrings) {
    try {
      uiStrings = JSON.parse(
        fs.readFileSync(path.resolve('content/ui/strings.json'), 'utf8')
      );
    } catch (err) {
      log.warn('ui strings unavailable', { reason: err.message });
      uiStrings = { strings: {}, status: {} };
    }
  }
  res.set('cache-control', 'public, max-age=60');
  res.json(uiStrings);
});

// ---------- lessons (cached by the service worker) ----------
app.get('/api/lessons', (req, res) => {
  res.set('cache-control', 'no-cache');
  res.json({ contentVersion: contentVersionToken(), lessons: listLessons() });
});

app.get('/api/lessons/:id', (req, res) => {
  const lesson = getLesson(req.params.id);
  if (!lesson) return fail(res, 404, 'no_lesson', 'unknown lesson');
  res.set('cache-control', 'public, max-age=60');
  res.json(lesson);
});

// ---------- sessions ----------
app.post(
  '/api/sessions',
  wrap(async (req, res) => {
    const topic = String(req.body?.topic || '').trim();
    if (!topic) return fail(res, 400, 'bad_topic', 'topic is required');
    if (topic.length > 160) return fail(res, 400, 'bad_topic', 'topic is too long');

    const lessonId = req.body?.lessonId ? String(req.body.lessonId) : defaultLesson()?.id;
    const lesson = getLesson(lessonId);
    if (!lesson) return fail(res, 400, 'no_lesson', 'unknown lesson');

    const language = /^[a-z]{2}$/.test(String(req.body?.language || ''))
      ? String(req.body.language)
      : 'kn';

    const session = createSession({
      topic,
      language,
      lessonId: lesson.id,
      contentVersion: lesson.contentVersion,
    });
    log.info('session created', { sessionId: session.id, language });
    appendEvent({
      sessionId: session.id,
      type: 'session.created',
      eventId: newId(),
      role: 'server',
      deviceId: 'server',
      payload: { lessonId: lesson.id, language, topic: session.topic },
    });
    res.status(201).json({ session: sessionSummary(session), lesson });
  })
);

app.get(
  '/api/sessions/:code',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');
    res.json({
      session: sessionSummary(session),
      lesson: getLesson(session.lesson_id) || defaultLesson(),
      candidates: session.status === 'OPEN' ? matchVolunteers(session) : [],
      transitions: transitionsFor(session.id),
      aiUsage: aiUsageStats(session.id),
    });
  })
);

// Everything a returning (second) volunteer needs to continue.
app.get(
  '/api/sessions/:code/bundle',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');
    res.json({
      session: sessionSummary(session),
      lesson: getLesson(session.lesson_id) || defaultLesson(),
      transitions: transitionsFor(session.id),
      events: eventsForSession(session.id).filter((e) => e.type !== 'message.translation'),
      interactions: interactionResponses(session.id).map((r) => ({
        seq: r.seq,
        result: r.payload.result,
        label: INTERACTION_LABELS[r.payload.result] || r.payload.result,
        stepId: r.payload.stageId,
        ts: r.ts,
      })),
      handoff: latestHandoff(session.id),
      aiUsage: aiUsageStats(session.id),
      states: STATES,
    });
  })
);

app.post(
  '/api/sessions/:code/match',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');
    const candidates = matchVolunteers(session, 5);
    for (const c of candidates) recordMatch(session.id, c);
    res.json({ candidates });
  })
);

app.post(
  '/api/sessions/:code/transition',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');

    const toState = String(req.body?.to || '');
    const actor = ['student', 'volunteer', 'facilitator', 'system'].includes(req.body?.actor)
      ? req.body.actor
      : 'facilitator';
    const meta = typeof req.body?.meta === 'object' && req.body.meta ? req.body.meta : {};

    if (toState === 'ACCEPTED') {
      const volunteerId = req.body?.volunteerId || session.volunteer_id;
      if (!volunteerId) return fail(res, 400, 'no_volunteer', 'volunteerId is required to accept');
      const v = db.prepare('SELECT * FROM volunteers WHERE id = ?').get(volunteerId);
      if (!v) return fail(res, 400, 'no_volunteer', 'unknown volunteer');
      meta.volunteerId = volunteerId;
      meta.volunteerName = v.name;
    }

    const event = transition({ sessionId: session.id, toState, actor, meta });

    if (toState === 'ACCEPTED' && meta.volunteerId) {
      db.prepare('UPDATE volunteers SET active_sessions = active_sessions + 1 WHERE id = ?').run(
        meta.volunteerId
      );
    }
    if (toState === 'CLOSED' && session.volunteer_id) {
      db.prepare(
        'UPDATE volunteers SET active_sessions = MAX(0, active_sessions - 1) WHERE id = ?'
      ).run(session.volunteer_id);
    }

    res.json({ event, session: sessionSummary(getSession(session.id)) });
  })
);

// ---------- student observations ----------
app.get(
  '/api/sessions/:code/interactions',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');
    res.json({
      interactions: interactionResponses(session.id).map((r) => ({
        seq: r.seq,
        label: INTERACTION_LABELS[r.payload.result] || r.payload.result,
        result: r.payload.result,
        stepId: r.payload.stepId,
        ts: r.ts,
      })),
    });
  })
);

// ---------- assessment (generic framework; content deferred) ----------
app.post(
  '/api/sessions/:code/assessments',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');

    const lesson = getLesson(session.lesson_id) || defaultLesson();
    const itemId = String(req.body?.itemId || '');
    const item = (lesson?.assessment || []).find((a) => a.id === itemId);
    if (!item) return fail(res, 400, 'no_item', 'unknown assessment item');

    const response = String(req.body?.response ?? '').slice(0, 200);
    if (!response) return fail(res, 400, 'bad_response', 'response is required');

    const index = item.options.indexOf(response);
    const isCorrect = item.correctIndex === undefined ? null : index === item.correctIndex;

    const event = appendEvent({
      sessionId: session.id,
      type: 'assessment.response',
      eventId: newId(),
      role: 'student',
      deviceId: session.student_device,
      payload: { itemId, response, isCorrect },
    }).event;

    db.prepare(
      `INSERT INTO assessment_responses (id, session_id, item_id, response, is_correct, event_id, seq, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newId(),
      session.id,
      itemId,
      response,
      isCorrect === null ? null : isCorrect ? 1 : 0,
      event.eventId,
      event.seq,
      Date.now()
    );

    res.status(201).json({
      event,
      isCorrect,
      explanation: item.explanation || null,
      correctIndex: item.correctIndex ?? null,
    });
  })
);

// ---------- evidence upload (camera photos) ----------
app.post(
  '/api/sessions/:code/evidence',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');

    // Handle multipart form data for image upload
    if (!req.is('multipart/form-data')) {
      return fail(res, 400, 'bad_request', 'expected multipart/form-data');
    }

    // Multer is not used; we parse manually from req.body and req.files
    let imageBase64 = req.body?.imageBase64;
    const sessionCode = req.body?.sessionCode;
    const deviceId = req.body?.deviceId;

    if (!imageBase64) return fail(res, 400, 'bad_request', 'image data required');
    if (!sessionCode) return fail(res, 400, 'bad_request', 'session code required');

    // Decode base64 image
    let imageBuffer;
    try {
      const base64Data = imageBase64.replace(/^data:image\/jpeg;base64,/, '').replace(/^data:image\/png;base64,/, '');
      imageBuffer = Buffer.from(base64Data, 'base64');
    } catch (err) {
      return fail(res, 400, 'bad_image', 'invalid base64 image data');
    }

    // Validate MIME type and size
    const maxSize = 2 * 1024 * 1024; // 2MB
    if (imageBuffer.length > maxSize) {
      const mb = (imageBuffer.length / 1024 / 1024).toFixed(2);
      return fail(res, 400, 'image_toolarge', `image too large: ${mb}MB, max 2MB`);
    }

    // Validate content type from data URL
    if (!/^data:image\/((jpeg|jfif|png)|png)$/.test(imageBase64)) {
      return fail(res, 400, 'bad_image', 'unsupported image format, use JPEG or PNG');
    }

    // Store evidence reference in the session events
    const eventId = newId();
    const ts = Date.now();

    const event = appendEvent({
      sessionId: session.id,
      type: 'student.evidence_submitted',
      eventId: eventId,
      role: 'student',
      deviceId: deviceId || session.student_device,
      payload: {
        imageDataUrl: imageBase64,
        imageMimeType: imageBase64.match(/^data:(image\/[^;]+)/)?.[1] || 'image/jpeg',
        imageSize: imageBuffer.length,
        ts,
      },
    });

    // Store in a simple evidence tracking table entry
    // We'll just persist the event; the frontend can read it from the bundle

    res.status(201).json({
      event,
      message: 'Evidence recorded',
    });
  })
);

// ---------- handoff & coaching ----------
app.post(
  '/api/sessions/:code/handoff',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');

    const handoff = await generateHandoff({ sessionId: session.id, provider });
    appendEvent({
      sessionId: session.id,
      type: 'handoff.created',
      eventId: newId(),
      role: 'system',
      deviceId: 'server',
      payload: { handoffId: handoff.id, aiStatus: handoff.aiStatus, evidenceLevel: handoff.evidenceLevel },
    });
    res.status(201).json({ handoff });
  })
);

app.get(
  '/api/sessions/:code/handoff',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');
    const handoff = latestHandoff(session.id);
    if (!handoff) return fail(res, 404, 'no_handoff', 'no handoff has been generated for this session');
    res.json({ handoff });
  })
);

app.post(
  '/api/sessions/:code/coaching',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');
    res.json({ coaching: await coachingTips({ sessionId: session.id, provider }) });
  })
);

// ---------- measurements ----------
app.get('/api/ai/stats', (req, res) => {
  res.json({ overall: aiUsageStats(), bySession: null });
});

app.get(
  '/api/sessions/:code/ai-usage',
  wrap(async (req, res) => {
    const session = byCode(req);
    if (!session) return fail(res, 404, 'no_session', 'unknown session code');
    res.json({ usage: aiUsageStats(session.id) });
  })
);

// ---------- static clients ----------
const publicDir = path.resolve('public');
app.get(['/', '/student', '/teacher', '/volunteer'], (req, res, next) => {
  const page = req.path === '/teacher' || req.path === '/volunteer' ? 'teacher.html' : req.path === '/student' ? 'student.html' : 'index.html';
  res.sendFile(path.join(publicDir, page), (err) => (err ? next() : undefined));
});
app.use(express.static(publicDir, { extensions: ['html'], maxAge: '5m', setHeaders: (res, file) => {
  if (file.endsWith('sw.js')) res.setHeader('cache-control', 'no-cache');
} }));

app.use((req, res) => {
  if (req.path.startsWith('/api')) return fail(res, 404, 'not_found', 'unknown endpoint');
  res.status(404).sendFile(path.join(publicDir, 'index.html'));
});

// ---------- start ----------
const server = http.createServer(app);
const relay = createRelay(server, { provider });

server.listen(config.port, config.host, () => {
  log.info('sahayak listening', {
    url: `http://${config.host}:${config.port}`,
    protocolVersion: PROTOCOL_VERSION,
    aiProvider: provider.name,
    aiConfigured: isAiConfigured(),
    payloadCapBps: config.payloadCapBps,
    contentVersion: contentVersionToken(),
  });
  if (!isAiConfigured()) {
    log.warn('AI unavailable — glossary and original text will still be served', {
      provider: config.ai.provider,
      enabled: config.ai.enabled,
      keyPresent: config.ai.apiKey.length > 0,
    });
  }
});

function shutdown(signal) {
  log.info('shutting down', { signal });
  relay.close();
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, server, relay };
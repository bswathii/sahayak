// smoke.test.js — end-to-end verification of the implemented checkpoints.
// Runs its own server on a throwaway database, drives two real WebSocket clients
// and every HTTP endpoint the UI uses, then reports PASS/FAIL per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.SMOKE_PORT || 3401);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.resolve('data/smoke.db');

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

function assert(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  return Boolean(condition);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function openClient(role, code, deviceId, since = 0) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const client = {
      role,
      ws,
      deviceId,
      frames: [],
      events: [],
      waiters: [],
      bytesIn: 0,
      close: () => ws.close(),
      send(type, payload, eventId) {
        const id = eventId || cryptoId();
        ws.send(JSON.stringify({ t: 'send', event: { v: 1, type, eventId: id, payload } }));
        return id;
      },
      waitFor(predicate, { timeout = 4000, label = 'frame' } = {}) {
        const found = client.frames.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            client.waiters = client.waiters.filter((w) => w.res !== res);
            reject(new Error(`timeout waiting for ${label}`));
          }, timeout);
          client.waiters.push({
            predicate,
            res: (frame) => {
              clearTimeout(timer);
              res(frame);
            },
          });
        });
      },
      waitEvent(type, { timeout = 4000 } = {}) {
        return client.waitFor((f) => f.t === 'event' && f.event.type === type, {
          timeout,
          label: `event ${type}`,
        });
      },
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: 1, role, code, deviceId, since }));
    });

    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      client.bytesIn += Buffer.byteLength(raw);
      client.frames.push(frame);
      if (frame.t === 'event') client.events.push(frame.event);
      for (const waiter of [...client.waiters]) {
        if (waiter.predicate(frame)) {
          client.waiters = client.waiters.filter((w) => w !== waiter);
          waiter.res(frame);
        }
      }
    });

    ws.on('error', reject);
    ws.on('close', () => {
      client.closed = true;
    });
    client.ready = client.waitFor((f) => f.t === 'snapshot', { label: 'snapshot' }).then(() => client);
    resolve(client);
  });
}

const cryptoId = () => globalThis.crypto.randomUUID();

// ---------------- run ----------------

let child;
async function main() {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(DB + suffix);
    } catch {
      /* fresh */
    }
  }

  child = spawn(process.execPath, ['src/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_PATH: DB,
      GEMINI_API_KEY: '',
      AI_ENABLED: 'true',
      LOG_LEVEL: 'warn',
      LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const line = d.toString();
    if (!line.includes('AI unavailable')) process.stderr.write(`[server] ${line}`);
  });

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(150);
    try {
      const res = await fetch(BASE + '/health');
      ready = res.ok;
    } catch {
      ready = false;
    }
  }
  if (!assert('server starts and /health reports ok', ready)) {
    process.exitCode = 1;
    return;
  }
  const health = await (await fetch(BASE + '/health')).json();
  assert(
    'health endpoint reports database and AI state',
    health.database === 'ok' && typeof health.ai.configured === 'boolean',
    `db=${health.database} aiConfigured=${health.ai.configured}`
  );

  // ---- session creation ----
  const created = await json('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ topic: 'Bridge supports and load', language: 'kn' }),
  });
  assert('creates a session with a code', created.status === 201 && /^[A-Z0-9]{6}$/.test(created.body.session.code));
  const code = created.body.session.code;

  const totalStarted = Date.now();
  const student = await openClient('student', code, 'dev-student-01');
  const volunteer = await openClient('volunteer', code, 'dev-volunteer-01');
  await Promise.all([student.ready, volunteer.ready]);
  assert('two independent clients join and receive a snapshot', student.frames.some((f) => f.t === 'snapshot') && volunteer.frames.some((f) => f.t === 'snapshot'));

  const snapshot = student.frames.find((f) => f.t === 'snapshot');
  assert(
    'snapshot carries activity content and a resume sequence',
    snapshot.session.lessonId === 'stickem-tallest-tower' && typeof snapshot.seq === 'number',
    `activity=${snapshot.session.lessonId} seq=${snapshot.seq}`
  );
  assert(
    'activity pack is labelled as the Round 1 demonstration activity',
    /DEMONSTRATION ACTIVITY/.test(snapshot.lessonLabel || '')
  );
  assert(
    'activity pack delivers the ten-stage pathway in three languages',
    snapshot.lesson.stages.length === 10 &&
      snapshot.lesson.stages[0].id === 'choose' &&
      snapshot.lesson.stages[9].id === 'reflect' &&
      ['en', 'hi', 'kn'].every((l) => snapshot.lesson.i18n[l]?.title),
    snapshot.lesson.stages.map((s) => s.id).join('>')
  );
  assert(
    'unverified activity details are marked for human confirmation',
    (snapshot.lesson.i18n.en.pendingConfirmation || []).length >= 1 &&
      snapshot.lesson.translationStatus === 'UNVERIFIED'
  );

  // ---- text + glossary translation ----
  const helloId = student.send('message.created', { text: 'Hello, can you hear me?', targetLang: 'kn' });
  const helloRelay = await volunteer.waitFor((f) => f.t === 'event' && f.event.eventId === helloId);
  assert('student text reaches the volunteer client', helloRelay.event.payload.text.startsWith('Hello'));

  const helloTranslation = await student.waitFor(
    (f) => f.t === 'event' && f.event.type === 'message.translation' && f.event.payload.forEventId === helloId
  );
  assert(
    'glossary answers without any AI request',
    helloTranslation.event.payload.source.startsWith('glossary'),
    `source=${helloTranslation.event.payload.source} status=${helloTranslation.event.payload.status}`
  );
  assert(
    'glossary translation is Kannda script and keeps original text',
    /[\u0C80-\u0CFF]/.test(helloTranslation.event.payload.translation || '') &&
      helloTranslation.event.payload.text === 'Hello, can you hear me?',
    helloTranslation.event.payload.translation
  );
  assert(
    'unreviewed glossaries are never reported as VERIFIED',
    helloTranslation.event.payload.status === 'UNVERIFIED',
    `status=${helloTranslation.event.payload.status}`
  );

  const replyId = volunteer.send('message.created', { text: 'Measure the length and check the angle', targetLang: 'kn' });
  const replyTranslation = await volunteer.waitFor(
    (f) => f.t === 'event' && f.event.type === 'message.translation' && f.event.payload.forEventId === replyId
  );
  assert(
    'partial glossary rendering is labelled UNVERIFIED with matched terms',
    replyTranslation.event.payload.status === 'UNVERIFIED' &&
      replyTranslation.event.payload.terms.length > 0,
    `terms=${replyTranslation.event.payload.terms.map((t) => t.en).join(',')}`
  );

  const unknownId = volunteer.send('message.created', { text: 'The weather is pleasant outside today', targetLang: 'kn' });
  const unknownTranslation = await volunteer.waitFor(
    (f) => f.t === 'event' && f.event.type === 'message.translation' && f.event.payload.forEventId === unknownId
  );
  assert(
    'untranslatable text falls back to original with FALLBACK status',
    unknownTranslation.event.payload.status === 'FALLBACK' &&
      unknownTranslation.event.payload.translation === null,
    `reason=${unknownTranslation.event.payload.reason}`
  );

  // ---- duplicate event handling ----
  const dupId = cryptoId();
  student.send('message.created', { text: 'Sending this twice', targetLang: 'kn' }, dupId);
  await sleep(120);
  student.ws.send(JSON.stringify({ t: 'send', event: { v: 1, type: 'message.created', eventId: dupId, payload: { text: 'Sending this twice', targetLang: 'kn' } } }));
  const dupFrame = await student.waitFor((f) => f.t === 'duplicate' && f.eventId === dupId);
  assert('a repeated eventId is acknowledged as a duplicate', dupFrame.eventId === dupId);
  const storedTexts = student.events.filter((e) => e.type === 'message.created' && e.eventId === dupId);
  assert('duplicate is not stored or fanned out twice', storedTexts.length === 1, `copies=${storedTexts.length}`);
  const seqs = student.events.map((e) => e.seq);
  assert(
    'sequence numbers are strictly increasing per session',
    seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
    `seqs=${seqs.join(',')}`
  );

  // ---- role guard ----
  student.send('drawing.stroke', { strokeId: 's-guard1', points: [[0.1, 0.1]], first: true, last: true });
  const guard = await student.waitFor((f) => f.t === 'error' && f.code === 'role_forbidden');
  assert('only the volunteer may draw on the board', guard.code === 'role_forbidden');

  volunteer.send('student.question_submitted', { stageId: 'question', text: 'Volunteer cannot answer for the student' });
  const workGuard = await volunteer.waitFor((f) => f.t === 'error' && f.code === 'role_forbidden');
  assert('only the student may record pathway work', workGuard.code === 'role_forbidden');

  // ---- whiteboard ----
  const strokeId = 's-' + Math.random().toString(36).slice(2, 9);
  volunteer.send('drawing.stroke', {
    strokeId,
    color: '#7fe3ff',
    width: 3,
    points: Array.from({ length: 20 }, (_, i) => [0.1 + i * 0.03, 0.4 + Math.sin(i / 3) * 0.1]),
    first: true,
    last: false,
  });
  volunteer.send('drawing.stroke', {
    strokeId,
    color: '#7fe3ff',
    width: 3,
    points: Array.from({ length: 20 }, (_, i) => [0.7 + i * 0.01, 0.6]),
    first: false,
    last: true,
  });
  await student.waitFor((f) => f.t === 'event' && f.event.type === 'drawing.stroke' && f.event.payload.strokeId === strokeId);
  await sleep(150);
  const chunks = student.events.filter((e) => e.type === 'drawing.stroke' && e.payload.strokeId === strokeId);
  const pointCount = chunks.reduce((n, c) => n + c.payload.points.length, 0);
  assert('vector stroke chunks reach the student', chunks.length === 2, `chunks=${chunks.length}`);
  assert('all 40 points arrive in order within two chunks', pointCount === 40, `points=${pointCount}`);
  assert(
    'stroke payload is vector data, not an image',
    chunks.every((c) => !('image' in c.payload) && Array.isArray(c.payload.points))
  );

  volunteer.send('drawing.cleared', {});
  const clearEvent = await student.waitFor((f) => f.t === 'event' && f.event.type === 'drawing.cleared');
  assert('board clear is relayed', clearEvent.event.type === 'drawing.cleared');

  // ---- pathway: stage changes, six text submissions, build, observation ----
  student.send('activity.selected', { activityId: 'stickem-tallest-tower' });
  const selected = await volunteer.waitFor((f) => f.t === 'event' && f.event.type === 'activity.selected');
  assert('activity selection is recorded', selected.event.payload.activityId === 'stickem-tallest-tower');

  student.send('activity.stage_changed', { stageId: 'predict' });
  const stageEvent = await volunteer.waitFor((f) => f.t === 'event' && f.event.type === 'activity.stage_changed');
  assert('stage changes reach the volunteer', stageEvent.event.payload.stageId === 'predict');

  student.send('activity.stage_changed', { stageId: 'step-2' });
  const stageGuard = await student.waitFor((f) => f.t === 'error' && f.code === 'unknown_stage');
  assert('a stage that is not in the activity is rejected', stageGuard.code === 'unknown_stage');

  const answers = {
    question: 'Will a triangle shape hold more weight than a square?',
    predict: 'I think the tower will fall when it is taller than my hand because it wobbles.',
    plan: 'Use triangles at the bottom, then narrow the tower towards the top.',
    explain: 'The bottom joints stayed tight but the top leaned over.',
    improve: 'Add another triangle near the top and start again.',
    reflect: 'Triangles make the frame stiff. I would test a taller base next time.',
  };
  const submitType = {
    question: 'student.question_submitted',
    predict: 'student.prediction_submitted',
    plan: 'student.plan_submitted',
    explain: 'student.explanation_submitted',
    improve: 'student.improvement_submitted',
    reflect: 'student.reflection_submitted',
  };
  for (const [stageId, text] of Object.entries(answers)) {
    student.send(submitType[stageId], { stageId, text });
  }
  student.send('student.build_started', { stageId: 'build' });
  student.send('student.observation_submitted', { stageId: 'test', result: 'need_help' });

  const obs = await volunteer.waitFor((f) => f.t === 'event' && f.event.type === 'student.observation_submitted');
  assert('student observation reaches the volunteer immediately', obs.event.payload.result === 'need_help');
  await sleep(200);
  const recorded = volunteer.events.filter(
    (e) => e.type.startsWith('student.') && e.type.endsWith('_submitted') && e.payload.text
  );
  assert('all six pathway answers are relayed and stored', recorded.length === 6, `${recorded.length} answers`);
  const build = volunteer.events.find((e) => e.type === 'student.build_started');
  assert('build start is recorded as a student action', build?.payload.stageId === 'build');

  // student sketch: same vector payload shape as the volunteer board
  student.send('student.drawing_submitted', {
    strokeId: 'sketch-1',
    color: '#7fe3ff',
    width: 2,
    points: [[0.1, 0.9], [0.5, 0.2], [0.9, 0.9]],
    first: true,
    last: true,
  });
  const sketchEvent = await volunteer.waitFor((f) => f.t === 'event' && f.event.type === 'student.drawing_submitted');
  assert('student sketch arrives as vector points', sketchEvent.event.payload.points.length === 3);

  // ---- measurement ----
  await sleep(1200);
  const windowSeconds = (Date.now() - totalStarted) / 1000;
  const payloadBytes = [...student.events, ...volunteer.events].reduce(
    (n, e) => n + Buffer.byteLength(JSON.stringify(e)),
    0
  );
  record(
    'payload measurement over the scenario',
    true,
    `${payloadBytes} bytes of events over ${windowSeconds.toFixed(1)} s = ${(payloadBytes / windowSeconds).toFixed(0)} B/s (both directions, both clients)`
  );
  assert('measured payload stays in kilobytes, not megabytes', payloadBytes < 60_000, `${payloadBytes} bytes`);

  // ---- reconnection + replay ----
  const studentLastSeq = Math.max(...student.events.map((e) => e.seq));
  student.close();
  await sleep(200);
  const offlineIds = [];
  offlineIds.push(volunteer.send('message.created', { text: 'Are you still there?', targetLang: 'kn' }));
  offlineIds.push(volunteer.send('message.created', { text: 'Look at the drawing', targetLang: 'kn' }));
  await sleep(250);

  // The reconnecting client asks for everything after what it had already seen.
  const reconnected = await openClient('student', code, 'dev-student-01', studentLastSeq);
  await reconnected.ready;
  const replay = await reconnected.waitFor((f) => f.t === 'replay');
  const replayedIds = replay.events.map((e) => e.eventId);
  assert(
    'reconnecting client receives exactly the missed events',
    offlineIds.every((id) => replayedIds.includes(id)),
    `missed=${replayedIds.length} since=${studentLastSeq}`
  );
  assert(
    'replay does not resend events the client already had',
    replay.events.every((e) => e.seq > studentLastSeq)
  );

  // Explicit replay.request is also supported (used when a sequence gap appears).
  reconnected.send('replay.request', { since: studentLastSeq });
  const explicit = await reconnected.waitFor((f) => f.t === 'replay.response');
  assert(
    'an explicit replay.request returns every event in order from the requested seq',
    explicit.since === studentLastSeq &&
      explicit.events.every((e) => e.seq > studentLastSeq) &&
      explicit.events.every((e, i) => i === 0 || e.seq > explicit.events[i - 1].seq) &&
      replayedIds.every((id) => explicit.events.some((e) => e.eventId === id)),
    `${explicit.events.length} events since #${studentLastSeq}`
  );

  // ---- lifecycle ----
  const shortlist = await json(`/api/sessions/${code}/match`, { method: 'POST' });
  assert(
    'volunteer matching returns explainable reasons',
    shortlist.status === 200 && shortlist.body.candidates[0].reasons.length >= 3,
    shortlist.body.candidates?.[0]?.reasons?.join(' | ')
  );
  const chosen = shortlist.body.candidates[0].volunteerId;

  const badTransition = await json(`/api/sessions/${code}/transition`, {
    method: 'POST',
    body: JSON.stringify({ to: 'CLOSED' }),
  });
  assert('invalid transition OPEN → CLOSED is refused', badTransition.status === 400, badTransition.body.error?.code);

  const offered = await json(`/api/sessions/${code}/transition`, {
    method: 'POST',
    body: JSON.stringify({ to: 'OFFERED', meta: { volunteerId: chosen, reasons: shortlist.body.candidates[0].reasons } }),
  });
  assert('OPEN → OFFERED is persisted', offered.status === 200 && offered.body.session.status === 'OFFERED');

  const accepted = await json(`/api/sessions/${code}/transition`, {
    method: 'POST',
    body: JSON.stringify({ to: 'ACCEPTED', volunteerId: chosen }),
  });
  assert('OFFERED → ACCEPTED assigns the volunteer', accepted.body.session.status === 'ACCEPTED' && accepted.body.session.volunteerId === chosen);

  const started = await json(`/api/sessions/${code}/transition`, { method: 'POST', body: JSON.stringify({ to: 'SESSION' }) });
  assert('ACCEPTED → SESSION records a start time', started.body.session.status === 'SESSION');

  const observed = await fetch(`${BASE}/api/sessions/${code}/interactions`).then((r) => r.json());
  assert('student observations are queryable from persistence', observed.interactions.some((i) => i.result === 'need_help'));

  // ---- handoff ----
  const handoffRes = await json(`/api/sessions/${code}/handoff`, { method: 'POST' });
  const handoff = handoffRes.body.handoff;
  assert('handoff is generated from persisted events', handoffRes.status === 201 && Boolean(handoff));
  assert(
    'handoff includes recorded student observations',
    (handoff.studentResponses || []).some((r) => r.label === 'I need help.'),
    JSON.stringify(handoff.studentResponses)
  );
  assert(
    'handoff records where help was requested',
    (handoff.helpRequests || []).length >= 1,
    `${handoff.helpRequests?.length} request(s)`
  );
  assert(
    'handoff falls back deterministically when AI is unavailable',
    handoff.aiStatus === 'FALLBACK_DETERMINISTIC',
    `aiStatus=${handoff.aiStatus}`
  );
  assert(
    'handoff states its evidence limits instead of claiming understanding',
    handoff.evidenceLevel === 'partial' && /not a verified measure/i.test(handoff.evidenceNotes),
    handoff.evidenceNotes
  );

  // ---- second volunteer continuity ----
  const bundle = await (await fetch(`${BASE}/api/sessions/${code}/bundle`)).json();
  const textInBundle = bundle.events.filter((e) => e.type === 'message.created');
  assert('a second volunteer receives the full message history', textInBundle.length >= 4, `${textInBundle.length} messages`);
  assert('a second volunteer receives the generated handoff', bundle.handoff?.summary?.length > 0);
  assert(
    'a second volunteer can see the student observations without reconstructing them',
    bundle.interactions.some((i) => i.result === 'need_help')
  );
  assert(
    'a second volunteer can see the student pathway answers',
    bundle.events.filter((e) => e.type === 'student.plan_submitted').length === 1
  );
  assert(
    'session.created and session.joined are part of the stored history',
    bundle.events.some((e) => e.type === 'session.created') &&
      bundle.events.some((e) => e.type === 'session.joined')
  );
  assert(
    'continuity bundle carries the completed lifecycle transitions',
    bundle.transitions.map((t) => t.to_state).join('>') === 'OFFERED>ACCEPTED>SESSION'
  );

  // ---- coaching (AI unavailable path) ----
  const coaching = await json(`/api/sessions/${code}/coaching`, { method: 'POST' });
  assert(
    'coaching tips fall back to rule-based advice',
    coaching.body.coaching?.aiStatus === 'FALLBACK_DETERMINISTIC' && coaching.body.coaching.tips.length > 0,
    `${coaching.body.coaching?.tips?.length} tip(s)`
  );
  assert(
    'coaching output is labelled indicative, not a volunteer score',
    /INDICATIVE/.test(coaching.body.coaching.label)
  );

  // ---- AI usage accounting ----
  const usage = await json(`/api/sessions/${code}/ai-usage`);
  const u = usage.body.usage;
  assert(
    'AI usage counts glossary lookups and fallbacks from real data',
    u.glossaryLookups >= 2 && u.fallback >= 1 && u.aiRequests === 0,
    `glossary=${u.glossaryLookups} aiRequests=${u.aiRequests} fallback=${u.fallback} share=${u.glossaryShare}%`
  );

  // ---- close the session and validate final state ----
  await json(`/api/sessions/${code}/transition`, { method: 'POST', body: JSON.stringify({ to: 'FEEDBACK' }) });
  const closed = await json(`/api/sessions/${code}/transition`, { method: 'POST', body: JSON.stringify({ to: 'CLOSED' }) });
  assert('FEEDBACK → CLOSED completes the lifecycle', closed.body.session.status === 'CLOSED');
  const reopen = await json(`/api/sessions/${code}/transition`, { method: 'POST', body: JSON.stringify({ to: 'SESSION' }) });
  assert('a closed session cannot be restarted', reopen.status === 400);

  const badCode = await fetch(`${BASE}/api/sessions/ZZZZZZ`);
  assert('unknown session codes are rejected', badCode.status === 404);

  const page = await fetch(`${BASE}/student`);
  assert('student route serves the client', page.status === 200 && /student/i.test(await page.text()));

  const sw = await fetch(`${BASE}/sw.js`);
  assert('service worker is served for caching', sw.status === 200);

  reconnected.close();
  volunteer.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED: ' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('\nSMOKE TEST CRASHED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(200);
    child?.kill('SIGTERM');
    await sleep(300);
  });

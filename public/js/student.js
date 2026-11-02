// student.js — student client: activity guide + ten-stage pathway + classroom.
// The pathway is driven by the activity pack; nothing about the tower is hardcoded here.
import {
  ClassroomClient,
  Board,
  deviceId,
  el,
  h,
  fmtBytes,
  registerServiceWorker,
} from './classroom.js';
import { Stream } from './stream.js';

// Result codes stay stable on the wire; only the visible label is translated.
const OBSERVATIONS = [
  ['it_works', 'obsItWorks'],
  ['it_does_not_work', 'obsItDoesNotWork'],
  ['im_stuck', 'obsStuck'],
  ['need_help', 'obsNeedHelp'],
  ['try_again', 'obsTryAgain'],
];

// Which event type a stage submits, when it has a text answer.
const SUBMIT_TYPE = {
  question: 'student.question_submitted',
  predict: 'student.prediction_submitted',
  plan: 'student.plan_submitted',
  explain: 'student.explanation_submitted',
  improve: 'student.improvement_submitted',
  reflect: 'student.reflection_submitted',
};

const FALLBACK_STRINGS = {
  appName: 'Sahayak',
  activity: 'Activity',
  stage: 'Stage',
  join: 'Join session',
  sessionCode: 'Session code',
  materials: 'Materials',
  constraints: 'Rules',
  pendingConfirmation: 'Pending human confirmation',
  conversation: 'Conversation',
  send: 'Send',
  typeMessage: 'Type in English…',
  drawingFromVolunteer: 'Drawing from your volunteer',
  yourAnswer: 'Your answer',
  saveAnswer: 'Save',
  saved: 'saved',
  previous: 'Previous',
  next: 'Next',
  sketch: 'Your sketch',
  clearSketch: 'Clear',
  network: 'Measurements',
  cached: 'lesson cached',
  notCached: 'lesson not cached',
  notReviewed: 'Prepared content — not yet reviewed by a native speaker.',
  obsItWorks: 'It works.',
  obsItDoesNotWork: 'It does not work.',
  obsStuck: "I'm stuck.",
  obsNeedHelp: 'I need help.',
  obsTryAgain: 'I want to try again.',
  observationNote: 'Your own observation — not a measurement of learning.',
};

const qs = new URLSearchParams(location.search);
let joinCode = (qs.get('code') || '').toUpperCase().trim();

let client = null;
let board = null;
let sketch = null;
let stream = null;
let session = null;
let lesson = null;
let lang = localStorage.getItem('sahayak.lang') || 'kn';
let strings = FALLBACK_STRINGS;
let stageIndex = 0;
let currentStageId = null;
const answers = new Map(); // stageId -> { type, text, ts }
const nodes = {}; // per-stage DOM refs that survive re-renders

const t = (key) => strings[key] || FALLBACK_STRINGS[key] || key;
const content = () => lesson?.i18n?.[lang] || lesson?.i18n?.en || {};

function stage() {
  return lesson?.stages?.[stageIndex] || lesson?.stages?.[0] || null;
}
function stageLabel(stageObj) {
  return stageObj?.title?.[lang] || stageObj?.title?.en || stageObj?.id || '';
}
function stagePrompt(stageObj) {
  return stageObj?.prompt?.[lang] || stageObj?.prompt?.en || '';
}

const setConn = (state, detail = '') => {
  const pill = el('#conn');
  pill.className = 'pill ' + state;
  pill.textContent = state + (detail ? ` · ${detail}` : '');
};

// ---------------- language ----------------
el('#lang').value = lang;
el('#lang').addEventListener('change', (ev) => {
  lang = ev.target.value;
  localStorage.setItem('sahayak.lang', lang);
  applyStrings();
  renderLesson();
  renderStages();
  renderStagePanel();
});

function applyStrings() {
  document.documentElement.lang = lang;
  el('#langLabel').textContent = lang === 'en' ? 'Language' : lang === 'hi' ? 'भाषा' : 'ಭಾಷೆ';
  el('#joinTitle').textContent = lang === 'en' ? 'Join a session' : t('join');
  el('#codeFieldLabel').textContent = t('sessionCode');
  el('#join').textContent = t('join');
  el('#activityHeading').textContent = t('activity');
  el('#pathwayHeading').textContent =
    lang === 'kn' ? 'ಕಲಿಕೆಯ ಹಾದಿ' : lang === 'hi' ? 'सीखने का रास्ता' : 'Learning pathway';
  el('#conversationHeading').textContent = t('conversation');
  el('#drawingHeading').textContent = t('drawingFromVolunteer');
  el('#networkHeading').textContent = t('network');
  el('#send').textContent = t('send');
  el('#input').placeholder = t('typeMessage');
  el('#prevStage').textContent = t('previous');
  el('#nextStage').textContent = t('next');
  updateStagePill();
}

function updateStagePill() {
  if (!currentStageId) return;
  const s = lesson?.stages?.find((x) => x.id === currentStageId);
  el('#stagePill').textContent = `${t('stage')} ${stageIndex + 1}/10 · ${stageLabel(s)}`;
  el('#stageProgress').textContent = `${stageIndex + 1} / ${lesson?.stages?.length || 10}`;
}

// ---------------- boot: strings, cache preview, meta ----------------
async function boot() {
  try {
    const res = await fetch('/api/ui');
    if (res.ok) {
      const data = await res.json();
      strings = { ...FALLBACK_STRINGS };
      for (const [key, value] of Object.entries(data.strings || {})) {
        strings[key] = value[lang] || value.en || key;
      }
    }
  } catch {
    /* offline: fall back to English labels */
  }
  applyStrings();

  // The activity is shown from cache before any session exists, so a student can
  // still read the challenge when the network is gone.
  await showCachedPreview();

  registerServiceWorker()
    .then(async (reg) => {
      if (!reg) return;
      await navigator.serviceWorker.ready;
      await showCachedPreview();
    })
    .catch(() => {});
}

async function showCachedPreview() {
  const box = el('#cachedPreview');
  if (!lesson) {
    try {
      const cached = await caches.match('/api/lessons/stickem-tallest-tower');
      if (cached) lesson = await cached.json();
    } catch {
      /* no cache */
    }
  }
  if (!lesson) return;
  const c = content();
  box.innerHTML = '';
  box.append(
    h('div', { class: 'notice' },
      h('strong', { text: c.title || lesson.id }),
      h('div', { class: 'small muted', style: 'margin-top:6px', text: c.challenge || '' }),
      h('div', { class: 'tiny muted', style: 'margin-top:8px', text: lesson.label || '' })
    )
  );
}

// ---------------- join ----------------
el('#code').value = joinCode;
el('#join').addEventListener('click', () => {
  const code = el('#code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    el('#joinErr').textContent = 'A session code has 6 characters.';
    return;
  }
  el('#joinErr').textContent = '';
  start(code);
});
if (joinCode) start(joinCode);

async function start(code) {
  el('#joinErr').textContent = '';
  let info;
  try {
    const res = await fetch(`/api/sessions/${code}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'unknown session code');
    info = data;
  } catch (err) {
    el('#joinErr').textContent = err.message;
    return;
  }

  session = info.session;
  lesson = info.lesson || lesson;
  lang = session.language || lang;
  el('#lang').value = lang;
  localStorage.setItem('sahayak.lang', lang);

  el('#joinPanel').hidden = true;
  el('#workspace').hidden = false;
  el('#codeLabel').textContent = session.code;
  el('#activityLabel').textContent = lesson?.label || '';
  setConn('connecting');
  applyStrings();
  renderLesson();
  renderStages();
  renderStagePanel();

  board = new Board(el('#board'), { readOnly: true });
  stream = new Stream(el('#stream'), { selfRole: 'student', language: session.language });

  client = new ClassroomClient({
    role: 'student',
    code: session.code,
    onStatus: ({ state, detail }) => setConn(state, detail),
    onSnapshot: (snap) => {
      session = { ...session, ...snap.session };
      if (snap.lesson) {
        lesson = snap.lesson;
        renderLesson();
        renderStages();
        renderStagePanel();
      }
      stream.system(`Joined session ${snap.session.code} as student (device ${deviceId.slice(0, 12)}…)`);
    },
    onEvent: (event) => {
      stream.addEvent(event);
      if (event.type === 'drawing.stroke') {
        board.applyChunk(event.payload);
        el('#strokeCount').textContent = `${board.order.length} strokes`;
      } else if (event.type === 'drawing.cleared') {
        board.clear(false);
        el('#strokeCount').textContent = '0 strokes';
      } else if (event.type === 'session.state') {
        // lifecycle changes are informational for the student
      } else if (event.actor?.role === 'student' || event.type === 'activity.stage_changed') {
        ingestWork(event);
      }
    },
    onPresence: (p) => {
      el('#presence').textContent = `${p.students} student · ${p.volunteers} volunteer`;
    },
    onError: (err) => stream.system(`${err.code}: ${err.message}`, { tone: 'bad' }),
  });
  client.connect();

  el('#send').addEventListener('click', sendText);
  el('#input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') sendText();
  });
  el('#resetMetrics').addEventListener('click', () => {
    if (client) client.metrics.startedAt = Date.now();
    renderMetrics();
  });
  el('#prevStage').addEventListener('click', () => goStage(stageIndex - 1));
  el('#nextStage').addEventListener('click', () => goStage(stageIndex + 1));

  setInterval(renderMetrics, 1000);
  renderMetrics();

  fetch('/api/meta')
    .then((r) => r.json())
    .then(() => {})
    .catch(() => {});

  await checkCachePill();
}

async function checkCachePill() {
  const pill = el('#cachePill');
  try {
    const reg = await registerServiceWorker();
    if (!reg) {
      pill.textContent = 'no service worker';
      return;
    }
    await navigator.serviceWorker.ready;
    // The first install may still be filling the cache, so check a few times
    // before reporting that the activity is not cached.
    let cached = null;
    for (let attempt = 0; attempt < 5 && !cached; attempt++) {
      cached = await caches.match(`/api/lessons/${lesson.id}`);
      if (!cached) await new Promise((r) => setTimeout(r, 600));
    }
    pill.textContent = cached ? t('cached') : t('notCached');
    pill.className = 'pill ' + (cached ? 'online' : '');
  } catch {
    pill.textContent = 'cache unavailable';
  }
}

// ---------------- activity guide ----------------
function renderLesson() {
  if (!lesson) return;
  const body = el('#lessonBody');
  const c = content();
  body.innerHTML = '';
  el('#activityHeading').textContent = c.title || lesson.id;

  const list = (items) =>
    h('ul', { style: 'margin:6px 0 0;padding-left:18px;line-height:1.6' },
      ...(items || []).map((i) => h('li', { class: 'small', text: i }))
    );

  body.append(
    h('div', { class: 'notice', text: lesson.label || '' }),
    h('p', { class: 'small', style: 'margin:10px 0 0;line-height:1.6', text: c.challenge || '' }),
    h('p', { class: 'small muted', style: 'margin:8px 0 0;line-height:1.6', text: c.objective || '' }),
    h('h3', { text: t('materials') }),
    list(c.materials),
    h('h3', { text: t('constraints') }),
    list(c.constraints)
  );

  if (c.guidance?.length) {
    body.append(h('h3', { text: lang === 'kn' ? 'ಹೇಗೆ ಮುಂದುವರಿಯುವುದು' : lang === 'hi' ? 'आगे कैसे बढ़ें' : 'How to work' }), list(c.guidance));
  }

  if (c.pendingConfirmation?.length) {
    body.append(
      h('div', { class: 'notice info', style: 'margin-top:12px' },
        h('strong', { class: 'small', text: t('pendingConfirmation') }),
        h('div', { class: 'tiny', text: 'These details are not in this build yet and are not invented:' }),
        list(c.pendingConfirmation)
      )
    );
  }

  if (lang !== 'en') {
    body.append(h('p', { class: 'tiny muted', style: 'margin-top:10px;line-height:1.5', text: t('notReviewed') }));
  }

  if (lesson.source) {
    body.append(
      h('p', { class: 'tiny muted', style: 'margin-top:10px' },
        h('a', { href: lesson.source.match(/https:\/\/\S+/)?.[0] || '#', target: '_blank', rel: 'noreferrer', text: 'Official activity reference' })
      )
    );
  }
}

// ---------------- pathway ----------------
function renderStages() {
  const box = el('#stages');
  if (!box || !lesson) return;
  box.innerHTML = '';
  lesson.stages.forEach((s, i) => {
    box.append(
      h('button', {
        class: 'stage-chip' + (i === stageIndex ? ' current' : '') + (answers.has(s.id) ? ' done' : ''),
        text: `${i + 1}. ${stageLabel(s)}`,
        onclick: () => goStage(i),
      })
    );
  });
  updateStagePill();
}

function goStage(index) {
  if (!lesson) return;
  const next = Math.max(0, Math.min(lesson.stages.length - 1, index));
  const target = lesson.stages[next];
  stageIndex = next;
  currentStageId = target.id;
  renderStages();
  renderStagePanel();
  // The volunteer's view follows the student's stage.
  client?.send('activity.stage_changed', { stageId: target.id });
}

function ingestWork(event) {
  if (event.type === 'activity.stage_changed') {
    const idx = lesson?.stages?.findIndex((s) => s.id === event.payload.stageId);
    if (idx >= 0 && event.actor?.deviceId === deviceId) {
      stageIndex = idx;
      currentStageId = event.payload.stageId;
      renderStages();
      renderStagePanel();
    }
    return;
  }
  const stageId = event.payload?.stageId;
  if (!stageId) return;
  if (event.type === 'student.build_started') {
    answers.set(stageId, { type: event.type, text: 'Building started', ts: event.ts });
  } else if (event.type.endsWith('_submitted') && event.payload.text) {
    answers.set(stageId, { type: event.type, text: event.payload.text, ts: event.ts });
  } else if (event.type === 'student.observation_submitted') {
    answers.set(stageId, { type: event.type, text: event.payload.label || event.payload.result, ts: event.ts });
  }
  if (stageId === currentStageId) renderStagePanel();
  renderStages();
}

function renderStagePanel() {
  const s = stage();
  const panel = el('#stagePanel');
  if (!s || !panel) return;
  panel.innerHTML = '';

  const saved = answers.get(s.id);
  panel.append(
    h('div', { class: 'tiny muted', text: `${t('stage')} ${stageIndex + 1} · ${s.key}` }),
    h('h3', { style: 'margin:4px 0 6px', text: stageLabel(s) }),
    h('p', { class: 'small', style: 'margin:0 0 10px;line-height:1.6', text: stagePrompt(s) })
  );

  if (s.input === 'text' || s.input === 'text+drawing') {
    const input = h('textarea', {
      class: 'answer-input',
      rows: '3',
      maxlength: '500',
      placeholder: t('yourAnswer'),
    });
    input.value = saved?.text || '';
    const status = h('span', { class: 'tiny muted' });
    const button = h('button', {
      class: 'primary small',
      text: t('saveAnswer'),
      onclick: () => {
        const text = input.value.trim();
        if (!text) return;
        const type = SUBMIT_TYPE[s.id];
        const ok = client?.send(type, { stageId: s.id, text });
        if (!ok) {
          status.textContent = 'Not connected — not saved.';
          return;
        }
        status.textContent = 'sending…';
      },
    });
    const row = h('div', { class: 'row wrap', style: 'margin-top:8px' }, button, status);
    panel.append(h('label', { text: t('yourAnswer') }), input, row);
    if (saved) panel.append(h('p', { class: 'tiny muted', style: 'margin-top:6px', text: `${t('saved')}: ${saved.text}` }));
  }

  if (s.input === 'text+drawing') {
    panel.append(h('label', { style: 'margin-top:12px', text: t('sketch') }));
    const canvas = h('canvas', { class: 'board sketch' });
    panel.append(canvas);
    sketch = new Board(canvas, {
      onChunk: (chunk) => {
        sketch.applyChunk(chunk);
        client?.send('student.drawing_submitted', chunk);
      },
    });
    panel.append(
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', {
          class: 'small ghost',
          text: t('clearSketch'),
          onclick: () => sketch.clear(false),
        }),
        h('span', { class: 'tiny muted', text: 'Sketch strokes are sent as vectors, one batch every ~100 ms.' })
      )
    );
  }

  if (s.input === 'start') {
    const status = h('span', { class: 'tiny muted', text: saved ? saved.text : '' });
    panel.append(
      h('button', {
        class: 'primary',
        text: lang === 'kn' ? 'ನಾನು ಕಟ್ಟಲು ಪ್ರಾರಂಭಿಸಿದ್ದೇನೆ' : lang === 'hi' ? 'मैंने बनाना शुरू किया' : 'I have started building',
        onclick: () => {
          const ok = client?.send('student.build_started', { stageId: s.id });
          status.textContent = ok ? 'recorded' : 'Not connected — not recorded.';
        },
      }),
      h('div', { style: 'margin-top:8px' }, status)
    );
  }

  if (s.input === 'observation') {
    const grid = h('div', { class: 'obs-grid' });
    for (const [result, labelKey] of OBSERVATIONS) {
      grid.append(
        h('button', {
          class: result === 'need_help' || result === 'im_stuck' ? 'danger' : '',
          text: t(labelKey),
          onclick: () => {
            const ok = client?.send('student.observation_submitted', { stageId: s.id, result });
            if (!ok) stream?.system('Not connected — observation not sent.', { tone: 'bad' });
          },
        })
      );
    }
    panel.append(
      grid,
      h('p', { class: 'tiny muted', style: 'margin:8px 0 0', text: t('observationNote') })
    );
    if (saved) panel.append(h('p', { class: 'tiny muted', text: `Recorded: ${saved.text}` }));
  }
}

// ---------------- conversation ----------------
function sendText() {
  const input = el('#input');
  const text = input.value.trim();
  if (!text) return;
  const ok = client?.send('message.created', { text, sourceLang: 'en', targetLang: session.language });
  if (!ok) {
    stream.system('Not connected — message not sent.', { tone: 'bad' });
    return;
  }
  input.value = '';
  input.focus();
}

// ---------------- metrics ----------------
function renderMetrics() {
  const m = client?.summary();
  if (!m) return;
  const rows = [
    ['sent (payload)', fmtBytes(m.bytesSent)],
    ['received (payload)', fmtBytes(m.bytesReceived)],
    ['payload / second', `${m.bytesPerSecond} B/s`],
    ['messages', `${m.messagesSent} out · ${m.messagesReceived} in`],
    ['latency last / avg', `${m.latencyLast ?? '—'} / ${m.latencyAvg ?? '—'} ms`],
    ['latency peak', `${m.latencyMax ?? '—'} ms`],
    ['session duration', `${Math.floor(m.durationSeconds / 60)}m ${m.durationSeconds % 60}s`],
    ['duplicates dropped', String(m.duplicates)],
    ['replayed / resyncs', `${m.resyncs}`],
  ];
  el('#metrics').innerHTML = rows
    .map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
}

boot();

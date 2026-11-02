// teacher.js — volunteer client: session lifecycle, whiteboard, handoff, coaching.
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

const STATES = ['OPEN', 'OFFERED', 'ACCEPTED', 'SESSION', 'FEEDBACK', 'CLOSED'];
const COLORS = ['#7fe3ff', '#ffffff', '#ffb347', '#68d391', '#ff6b6b', '#c084fc'];
const HANDOFF_LIMITED = 'Built only from persisted events. Where evidence is missing, this handoff says so.';

const qs = new URLSearchParams(location.search);
let presetCode = (qs.get('code') || '').toUpperCase().trim();

let client = null;
let board = null;
let stream = null;
let session = null;
let lesson = null;
let candidates = [];
let currentStageId = null;
let messageCount = 0;

const setConn = (state, detail = '') => {
  const pill = el('#conn');
  pill.className = 'pill ' + state;
  pill.textContent = state + (detail ? ` · ${detail}` : '');
};

// ---------------- boot ----------------
async function boot() {
  try {
    const meta = await (await fetch('/api/meta')).json();
    const pill = el('#aiPill');
    if (meta.ai.configured) {
      pill.textContent = `AI: ${meta.ai.provider}`;
      pill.className = 'pill online';
    } else if (!meta.ai.enabled) {
      pill.textContent = 'AI: off (kill-switch)';
    } else {
      pill.textContent = 'AI: glossary only';
    }
  } catch {
    el('#aiPill').textContent = 'AI: unknown';
  }

  try {
    const data = await (await fetch('/api/lessons')).json();
    el('#lesson').innerHTML = data.lessons
      .map((l) => `<option value="${l.id}">${l.title} — v${l.contentVersion}</option>`)
      .join('');
  } catch {
    /* non-fatal */
  }

  el('#code').value = presetCode;
  if (presetCode) join(presetCode);
}

el('#create').addEventListener('click', async () => {
  el('#entryErr').textContent = '';
  el('#create').disabled = true;
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: el('#topic').value.trim() || 'Tallest tower challenge',
        language: el('#language').value,
        lessonId: el('#lesson').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'could not create session');
    await join(data.session.code);
  } catch (err) {
    el('#entryErr').textContent = err.message;
  } finally {
    el('#create').disabled = false;
  }
});

el('#join').addEventListener('click', () => {
  const code = el('#code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    el('#entryErr').textContent = 'A session code has 6 characters.';
    return;
  }
  join(code);
});

// ---------------- join ----------------
async function join(code) {
  el('#entryErr').textContent = '';
  let info;
  try {
    const res = await fetch(`/api/sessions/${code}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'unknown session code');
    info = data;
  } catch (err) {
    el('#entryErr').textContent = err.message;
    return;
  }

  session = info.session;
  lesson = info.lesson;
  candidates = info.candidates || [];
  currentStageId = lesson?.stages?.[0]?.id || null;

  el('#entryPanel').hidden = true;
  el('#workspace').hidden = false;
  el('#codeLabel').textContent = session.code;

  board = new Board(el('#board'), {
    onChunk: (chunk) => {
      board.applyChunk(chunk);
      client?.send('drawing.stroke', chunk);
      el('#strokeCount').textContent = `${board.order.length} strokes`;
    },
    onClear: () => client?.send('drawing.cleared', {}),
  });

  stream = new Stream(el('#stream'), { selfRole: 'volunteer', language: session.language });
  renderLesson();
  renderState();
  renderLifecycle();
  renderCandidates();

  client = new ClassroomClient({
    role: 'volunteer',
    code: session.code,
    onStatus: ({ state, detail }) => setConn(state, detail),
    onSnapshot: (snap) => {
      session = { ...session, ...snap.session };
      if (snap.lesson) lesson = snap.lesson;
      renderState();
      renderLifecycle();
      renderLesson();
      stream.system(`Attached to session ${snap.session.code} as volunteer · resume point #${snap.seq}`);
    },
    onEvent: (event) => {
      if (event.type === 'message.created') messageCount += 1;
      el('#msgCount').textContent = `${messageCount} messages`;

      if (event.type === 'drawing.stroke') {
        // Skip the echo of our own strokes: they are already drawn locally.
        if (event.actor?.deviceId !== deviceId) {
          board.applyChunk(event.payload);
          el('#strokeCount').textContent = `${board.order.length} strokes`;
        }
        return;
      }
      if (event.type === 'drawing.cleared') {
        if (event.actor?.deviceId !== deviceId) board.clear(false);
        el('#strokeCount').textContent = '0 strokes';
        stream.addEvent(event);
        return;
      }
      stream.addEvent(event);
      if (event.type === 'session.state') {
        session.status = event.payload.to;
        renderState();
        renderLifecycle();
      }
      if (event.type === 'activity.stage_changed') {
        currentStageId = event.payload.stageId;
        renderLesson();
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
  el('#clearBoard').addEventListener('click', () => {
    board.clear(true);
    el('#strokeCount').textContent = '0 strokes';
  });
  el('#resetMetrics').addEventListener('click', () => {
    if (client) client.metrics.startedAt = Date.now();
    renderMetrics();
  });

  const swatches = el('#swatches');
  swatches.innerHTML = '';
  COLORS.forEach((color, i) => {
    swatches.append(
      h('button', {
        class: 'swatch' + (i === 0 ? ' active' : ''),
        style: `background:${color}`,
        'aria-label': color,
        onclick: (ev) => {
          board.color = color;
          swatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
          ev.currentTarget.classList.add('active');
        },
      })
    );
  });
  el('#width').addEventListener('input', (ev) => {
    board.width = Number(ev.target.value);
  });

  el('#genHandoff').addEventListener('click', generateHandoff);
  el('#genTips').addEventListener('click', generateTips);

  setInterval(renderMetrics, 1000);
  renderMetrics();
  void registerServiceWorker().then(async () => {
    try {
      await navigator.serviceWorker.ready;
      const cached = await caches.match(`/api/lessons/${lesson?.id}`);
      el('#cachePill').textContent = cached ? 'lesson cached' : 'lesson not cached';
      el('#cachePill').className = 'pill ' + (cached ? 'online' : '');
    } catch {
      el('#cachePill').textContent = 'cache unavailable';
    }
  });

  await loadContinuity();
}

async function loadContinuity() {
  try {
    const res = await fetch(`/api/sessions/${session.code}/bundle`);
    const data = await res.json();
    if (!res.ok) return;
    session = data.session;
    renderState();
    renderLifecycle();
    if (data.handoff) renderHandoff(data.handoff);
    else if (data.events?.length) {
      el('#handoffBody').innerHTML =
        '<p class="small muted">This session already has recorded activity but no handoff yet. Generate one to brief the next volunteer.</p>';
    }
  } catch {
    /* ignore */
  }
}

// ---------------- rendering ----------------
function renderState() {
  if (!session) return;
  el('#statePill').textContent = session.status;
  el('#topicLabel').textContent = session.topic;
  el('#langLabel').textContent =
    session.language === 'kn' ? 'Kannada (ಕನ್ನಡ)' : session.language === 'hi' ? 'Hindi (हिन्दी)' : 'English';
  el('#volLabel').textContent = session.volunteerId || (session.status === 'OPEN' ? 'not assigned' : '—');

  const current = STATES.indexOf(session.status);
  el('#stateChain').innerHTML = STATES.map((s, i) => {
    const cls = i < current ? 'done' : i === current ? 'current' : '';
    return `<span class="step ${cls}">${s}</span>`;
  }).join('<span class="tiny muted">›</span>');
}

function renderLifecycle() {
  const box = el('#lifecycleButtons');
  box.innerHTML = '';
  if (!session) return;

  const add = (label, cls, fn) =>
    box.append(h('button', { class: `small ${cls}`, text: label, onclick: fn }));

  const doTransition = async (to, extra = {}) => {
    box.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const res = await fetch(`/api/sessions/${session.code}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, actor: 'volunteer', ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || 'transition refused');
      session = data.session;
      renderState();
      renderLifecycle();
    } catch (err) {
      stream.system(`Lifecycle: ${err.message}`, { tone: 'bad' });
      renderLifecycle();
    }
  };

  switch (session.status) {
    case 'OPEN':
      if (candidates.length) {
        add(`Offer to ${candidates[0].name}`, 'primary', () =>
          doTransition('OFFERED', {
            meta: {
              volunteerId: candidates[0].volunteerId,
              score: candidates[0].score,
              reasons: candidates[0].reasons,
            },
          })
        );
      } else {
        add('Find volunteers', '', refreshCandidates);
      }
      break;
    case 'OFFERED':
      add('Accept offer', 'primary', () =>
        doTransition('ACCEPTED', { volunteerId: session.volunteerId || candidates[0]?.volunteerId })
      );
      add('Back to open', 'ghost', () => doTransition('OPEN'));
      break;
    case 'ACCEPTED':
      add('Start session', 'primary', () => doTransition('SESSION'));
      add('Cancel', 'ghost', () => doTransition('OPEN'));
      break;
    case 'SESSION':
      add('End and record feedback', 'primary', () => doTransition('FEEDBACK'));
      break;
    case 'FEEDBACK':
      add('Close session', 'primary', () => doTransition('CLOSED'));
      break;
    default:
      box.append(h('span', { class: 'small muted', text: 'This session is closed. Its history stays available for continuity.' }));
  }
}

async function refreshCandidates() {
  try {
    const res = await fetch(`/api/sessions/${session.code}/match`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'matching failed');
    candidates = data.candidates;
    renderCandidates();
    renderLifecycle();
  } catch (err) {
    stream.system(`Matching: ${err.message}`, { tone: 'bad' });
  }
}

function renderCandidates() {
  const box = el('#matchBox');
  box.innerHTML = '';
  if (session?.status !== 'OPEN' || !candidates.length) return;

  box.append(h('div', { class: 'tiny muted', text: 'SUGGESTED VOLUNTEERS — explicit criteria, no hidden score' }));
  for (const c of candidates) {
    const reasons = h('ul', { style: 'margin:6px 0 0;padding-left:16px;font-size:12px;line-height:1.55;color:#b9cbdb' },
      ...c.reasons.map((r) => h('li', { text: r }))
    );
    box.append(
      h('div', { class: 'lesson-step', style: 'margin-top:8px' },
        h('div', { class: 'row' },
          h('strong', { style: 'font-size:13px', text: c.name }),
          h('span', { class: 'pill', text: `score ${c.score}/100` })
        ),
        reasons
      )
    );
  }
  box.append(
    h('p', { class: 'tiny muted', style: 'margin-top:8px' },
      'Language 40 · subject 35 · stated availability 15 · current load 10. Seeded volunteer records; not a performance ranking of people.')
  );
}

function renderLesson() {
  if (!lesson) return;
  const body = el('#lessonBody');
  body.innerHTML = '';
  body.append(
    h('p', { class: 'tiny muted', style: 'margin:0 0 8px', text: lesson.label || '' }),
    h('strong', { class: 'small', text: lesson.i18n?.[session?.language]?.title || lesson.i18n?.en?.title || lesson.id }),
    h('p', { class: 'small muted', style: 'margin:6px 0 10px;line-height:1.55', text: lesson.i18n?.en?.challenge || '' })
  );

  // The student owns their stage; the volunteer sees where they are and reads
  // the same prompt, but cannot move them.
  for (const [i, stage] of (lesson.stages || []).entries()) {
    body.append(
      h('div', { class: 'lesson-step' + (stage.id === currentStageId ? ' current' : '') },
        h('h3', { text: `${i + 1}. ${stage.title?.en || stage.id}` }),
        h('p', { text: stage.prompt?.en || '' }),
        stage.id === currentStageId ? h('span', { class: 'badge badge-verified', text: 'student is here' }) : null
      )
    );
  }

  const current = (lesson.stages || []).find((s) => s.id === currentStageId);
  el('#stageLabel').textContent = current
    ? `${(lesson.stages.indexOf(current) + 1)}/10 · ${current.title?.en || current.id}`
    : '—';
}

function renderHandoff(handoff) {
  const box = el('#handoffBody');
  box.innerHTML = '';
  const badge = h('span', {
    class: 'badge ' + (handoff.aiStatus === 'AI_GENERATED' ? 'badge-ai_translation' : 'badge-unverified'),
    text: handoff.aiStatus === 'AI_GENERATED' ? 'AI-GENERATED SUMMARY' : 'DETERMINISTIC FALLBACK',
  });

  box.append(
    h('div', { class: 'row wrap' }, badge, h('span', { class: 'pill', text: `evidence: ${handoff.evidenceLevel}` })),
    h('p', { class: 'small', text: handoff.summary }),
    h('div', { class: 'tiny muted', text: handoff.evidenceNotes })
  );

  const section = (title, items) => {
    if (!items?.length) return;
    box.append(h('h4', { text: title }), h('ul', {}, ...items.map((i) => h('li', { text: String(i) }))));
  };

  section('Topics discussed', handoff.topicsDiscussed);
  section('Concepts and terms covered', handoff.conceptsCovered);
  section(
    'Student observations',
    (handoff.studentResponses || []).map((r) => `${r.label}${r.stepId ? ` (step ${r.stepId})` : ''}`)
  );
  section('Where help was requested', (handoff.helpRequests || []).map((r) => `${r.label}${r.stepId ? ` · ${r.stepId}` : ''}`));
  section('Terms that needed clarification', handoff.termsRequiringClarification);
  section('Unanswered questions', handoff.unresolvedQuestions);
  section('Assessments recorded', (handoff.assessments || []).map((a) => `${a.itemId}: ${a.correct === null ? 'no objective answer key' : a.correct ? 'correct' : 'incorrect'}`));

  if (handoff.suggestedNextInteraction) {
    box.append(
      h('h4', { text: 'Suggested next interaction' }),
      h('p', { class: 'small', text: handoff.suggestedNextInteraction })
    );
  }
  box.append(h('p', { class: 'tiny muted', style: 'margin-top:10px', text: HANDOFF_LIMITED }));
}

async function generateHandoff() {
  const button = el('#genHandoff');
  button.disabled = true;
  button.textContent = 'Generating…';
  try {
    const res = await fetch(`/api/sessions/${session.code}/handoff`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'handoff failed');
    renderHandoff(data.handoff);
  } catch (err) {
    el('#handoffBody').innerHTML = `<p class="small err">${err.message}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Generate';
  }
}

async function generateTips() {
  const button = el('#genTips');
  button.disabled = true;
  button.textContent = 'Thinking…';
  const box = el('#tipsBody');
  try {
    const res = await fetch(`/api/sessions/${session.code}/coaching`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'coaching failed');
    const c = data.coaching;
    box.innerHTML = '';
    box.append(
      h('div', { class: 'row wrap' },
        h('span', {
          class: 'badge ' + (c.aiStatus === 'AI_GENERATED' ? 'badge-ai_translation' : 'badge-unverified'),
          text: c.aiStatus === 'AI_GENERATED' ? 'AI-SUGGESTED' : 'RULE-BASED',
        }),
        h('span', { class: 'pill', text: `evidence: ${c.evidenceLevel}` })
      ),
      h('p', { class: 'tiny muted', text: c.label })
    );
    box.append(
      h('ul', { style: 'padding-left:16px;line-height:1.6;font-size:13px' },
        ...c.tips.map((t) => h('li', {}, h('div', { text: t.text }), h('div', { class: 'tiny muted', text: t.rationale })))
      )
    );
    box.append(h('p', { class: 'tiny muted', text: c.evidenceNotes }));
  } catch (err) {
    box.innerHTML = `<p class="small err">${err.message}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Suggest';
  }
}

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
    ['recovery requests', `${m.recoveries ?? 0} · ${m.recoveredEvents ?? 0} events`],
  ];
  el('#metrics').innerHTML = rows
    .map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
}

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

boot();

// handoff.js — structured handoff built from persisted session events only.
// Every claim in the output traces back to a stored event; when there is not
// enough evidence the handoff says so instead of inventing understanding.
import crypto from 'node:crypto';
import { db } from './db.js';
import {
  getSession,
  transitionsFor,
  textEvents,
  interactionResponses,
} from './sessions.js';
import { INTERACTION_LABELS } from './protocol.js';
import { recordAiUsage } from './translation.js';
import { log } from './log.js';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildEvidence(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;

  const messages = textEvents(sessionId).map((m) => ({
    seq: m.seq,
    role: m.actor_role,
    text: m.payload?.text || '',
    translated: m.payload?.targetLang ? m.payload.targetLang : null,
    ts: m.ts,
  }));

  // Interactions are student observations, never measurements of understanding.
  const interactions = interactionResponses(sessionId).map((r) => ({
    seq: r.seq,
    result: r.payload.result,
    label: INTERACTION_LABELS[r.payload.result] || r.payload.result,
    stepId: r.payload.stageId || null,
    note: r.payload.note || null,
    ts: r.ts,
  }));

  const stepRows = db
    .prepare(
      `SELECT seq, payload, ts FROM events WHERE session_id = ? AND type = 'activity.stage_changed' ORDER BY seq ASC`
    )
    .all(sessionId);
  const stepsVisited = [...new Set(stepRows.map((r) => JSON.parse(r.payload).stageId))];

  const translations = db
    .prepare(
      `SELECT seq, payload FROM events WHERE session_id = ? AND type = 'message.translation' ORDER BY seq ASC`
    )
    .all(sessionId)
    .map((r) => JSON.parse(r.payload));

  const termMap = new Map();
  for (const t of translations) {
    for (const term of t.terms || []) {
      if (!termMap.has(term.en)) termMap.set(term.en, { en: term.en, kn: term.tr, count: 0, status: term.status });
      termMap.get(term.en).count += 1;
    }
  }

  const assessments = db
    .prepare(
      `SELECT item_id, response, is_correct, ts FROM assessment_responses
       WHERE session_id = ? ORDER BY ts ASC`
    )
    .all(sessionId);

  return {
    session: {
      id: session.id,
      topic: session.topic,
      language: session.language,
      status: session.status,
      lessonId: session.lesson_id,
      contentVersion: session.content_version,
      startedAt: session.started_at,
      endedAt: session.ended_at,
    },
    transitions: transitionsFor(sessionId).map((t) => ({
      from: t.from_state,
      to: t.to_state,
      actor: t.actor,
      ts: t.ts,
    })),
    messages,
    interactions,
    stepsVisited,
    terms: [...termMap.values()],
    assessments,
  };
}

/** Deterministic, evidence-only handoff. Always available, no AI required. */
export function deterministicHandoff(evidence) {
  const { session, messages, interactions, stepsVisited, terms, assessments } = evidence;

  const studentMessages = messages.filter((m) => m.role === 'student');
  const volunteerMessages = messages.filter((m) => m.role !== 'student');
  const helpInteractions = interactions.filter(
    (i) => i.result === 'need_help' || i.result === 'im_stuck'
  );
  const failureInteractions = interactions.filter((i) => i.result === 'it_does_not_work');

  // A question counts as unresolved when the volunteer asked it and no student
  // message followed it.
  const lastStudentSeq = studentMessages.length
    ? Math.max(...studentMessages.map((m) => m.seq))
    : 0;
  const unresolvedQuestions = volunteerMessages
    .filter((m) => m.text.includes('?') && m.seq > lastStudentSeq)
    .slice(-3)
    .map((m) => clip(m.text, 180));

  const evidenceLevel =
    messages.length === 0 && interactions.length === 0
      ? 'none'
      : interactions.length === 0
        ? 'minimal'
        : studentMessages.length === 0
          ? 'minimal'
          : 'partial';

  const topicsDiscussed = [
    `Session topic: ${session.topic}`,
    ...(stepsVisited.length ? [`Lesson steps opened: ${stepsVisited.join(', ')}`] : []),
  ];

  const conceptsCovered = terms.length
    ? terms.map((t) => `${t.en} (${t.kn}) — used ${t.count}×`)
    : ['No glossary terms were used in recorded messages.'];

  const summaryParts = [
    `Student and volunteer exchanged ${messages.length} message(s) in a ${session.language === 'kn' ? 'Kannada' : session.language.toUpperCase()} session about "${session.topic}".`,
    interactions.length
      ? `The student reported ${interactions.length} observation(s), of which ${helpInteractions.length} asked for help.`
      : 'The student recorded no observations, so nothing is known about how the task went.',
    `Session reached state ${session.status}.`,
  ];

  const suggestedNextInteraction = helpInteractions.length
    ? `Ask the student to describe what happened when they tried step "${helpInteractions.at(-1).stepId || 'the current step'}", then re-explain using a drawing rather than more text.`
    : unresolvedQuestions.length
      ? 'Return to the unanswered question above and ask the student for a short answer in their own words.'
      : 'Ask one open question about what the student noticed, and record their answer before continuing.';

  return {
    topicsDiscussed,
    conceptsCovered,
    studentResponses: interactions.length
      ? interactions.map((i) => ({
          label: i.label,
          stepId: i.stepId,
          note: i.note,
          at: new Date(i.ts).toISOString(),
        }))
      : [],
    helpRequests: helpInteractions.map((i) => ({
      label: i.label,
      stepId: i.stepId,
      at: new Date(i.ts).toISOString(),
    })),
    failureReports: failureInteractions.map((i) => ({ label: i.label, stepId: i.stepId })),
    termsRequiringClarification: terms.map((t) => `${t.en} → ${t.kn}`),
    unresolvedQuestions,
    assessments: assessments.map((a) => ({
      itemId: a.item_id,
      correct: a.is_correct === 1 ? true : a.is_correct === 0 ? false : null,
    })),
    summary: summaryParts.join(' '),
    suggestedNextInteraction,
    evidenceLevel,
    evidenceNotes:
      evidenceLevel === 'none'
        ? 'No messages or observations were recorded, so this handoff contains no evidence about the student at all.'
        : evidenceLevel === 'minimal'
          ? 'Only limited evidence exists: student observations or replies are missing, so this handoff cannot say whether the student understood anything.'
          : 'Evidence is partial: this handoff records what was said and reported, not a verified measure of understanding.',
  };
}

/** AI enrichment of the deterministic handoff. Failure keeps the deterministic one. */
export async function generateHandoff({ sessionId, provider }) {
  const evidence = buildEvidence(sessionId);
  if (!evidence) throw { code: 'no_session', message: 'session not found' };

  const base = deterministicHandoff(evidence);
  let source = 'deterministic';
  let aiStatus = 'FALLBACK_DETERMINISTIC';
  let model = null;

  if (provider && provider.available()) {
    recordAiUsage({ sessionId, operation: 'summarize_handoff', outcome: 'ai_request' });
    try {
      const out = await provider.summarizeHandoff({
        evidence: {
          topic: evidence.session.topic,
          language: evidence.session.language,
          status: evidence.session.status,
          messages: evidence.messages.map((m) => ({ role: m.role, text: m.text })),
          interactions: evidence.interactions.map((i) => ({ label: i.label, stepId: i.stepId })),
          stepsVisited: evidence.stepsVisited,
          terms: evidence.terms.map((t) => t.en),
          evidenceLevel: base.evidenceLevel,
        },
      });
      if (out.summary) {
        base.summary = out.summary;
        base.suggestedNextInteraction = out.suggestedNextInteraction || base.suggestedNextInteraction;
        source = 'ai';
        aiStatus = 'AI_GENERATED';
        model = out.model || null;
      }
      recordAiUsage({
        sessionId,
        operation: 'summarize_handoff',
        outcome: 'ai_success',
        latencyMs: out.latencyMs,
        detail: out.model,
      });
    } catch (err) {
      recordAiUsage({
        sessionId,
        operation: 'summarize_handoff',
        outcome: 'ai_failure',
        latencyMs: err.latencyMs ?? null,
        detail: err.message,
      });
      log.warn('handoff generation fell back', { reason: err.message });
    }
  }

  const payload = { ...base, source, aiStatus, model };
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO handoffs (id, session_id, source, model, ai_status, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sessionId, source, model, aiStatus, JSON.stringify(payload), Date.now());

  return { id, sessionId, ...payload };
}

export function latestHandoff(sessionId) {
  const row = db
    .prepare('SELECT * FROM handoffs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(sessionId);
  if (!row) return null;
  return { id: row.id, sessionId: row.session_id, createdAt: row.created_at, ...JSON.parse(row.payload) };
}

/** Private, indicative coaching suggestions. Never a public ranking or a score. */
export async function coachingTips({ sessionId, provider }) {
  const evidence = buildEvidence(sessionId);
  if (!evidence) throw { code: 'no_session', message: 'session not found' };
  const base = deterministicHandoff(evidence);

  const tips = [];
  if (base.helpRequests.length) {
    tips.push({
      text: `Re-explain step "${base.helpRequests.at(-1).stepId || 'the current step'}" with a drawing before adding more text.`,
      rationale: `The student pressed "I need help"/"I'm stuck" ${base.helpRequests.length} time(s) in this session.`,
    });
  }
  if (base.termsRequiringClarification.length) {
    tips.push({
      text: `Check that these terms are understood: ${base.termsRequiringClarification.slice(0, 4).join(', ')}.`,
      rationale: 'These were the terms that appeared in translated messages.',
    });
  }
  if (base.unresolvedQuestions.length) {
    tips.push({
      text: 'Ask the student to answer your last question in their own words before moving on.',
      rationale: 'A question you asked was never answered in the recorded messages.',
    });
  }
  if (!tips.length) {
    tips.push({
      text: 'Record at least one student observation, then ask one open question.',
      rationale: `Evidence level for this session is "${base.evidenceLevel}".`,
    });
  }

  let aiStatus = 'FALLBACK_DETERMINISTIC';
  let model = null;
  if (provider && provider.available()) {
    recordAiUsage({ sessionId, operation: 'coaching_tips', outcome: 'ai_request' });
    try {
      const out = await provider.coachingTips({
        evidence: {
          topic: evidence.session.topic,
          interactions: evidence.interactions.map((i) => ({ label: i.label, stepId: i.stepId })),
          terms: evidence.terms.map((t) => t.en),
          messages: evidence.messages.slice(-10).map((m) => ({ role: m.role, text: m.text })),
          evidenceLevel: base.evidenceLevel,
        },
      });
      if (out.tips.length) {
        tips.unshift(...out.tips);
        aiStatus = 'AI_GENERATED';
        model = out.model || null;
      }
      recordAiUsage({
        sessionId,
        operation: 'coaching_tips',
        outcome: 'ai_success',
        latencyMs: out.latencyMs,
        detail: out.model,
      });
    } catch (err) {
      recordAiUsage({
        sessionId,
        operation: 'coaching_tips',
        outcome: 'ai_failure',
        latencyMs: err.latencyMs ?? null,
        detail: err.message,
      });
      log.warn('coaching tips fell back', { reason: err.message });
    }
  }

  return {
    sessionId,
    aiStatus,
    model,
    label: 'INDICATIVE SUGGESTIONS — not an assessment of the volunteer',
    evidenceLevel: base.evidenceLevel,
    evidenceNotes: base.evidenceNotes,
    tips: tips.slice(0, 5),
  };
}

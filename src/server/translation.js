// translation.js — glossary-first translation. The classroom never waits for this:
// text events are broadcast immediately and a translation event follows if one exists.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { log } from './log.js';
import { TRANSLATION_STATUS } from './protocol.js';
import { AIUnavailableError } from './ai/provider.js';

// ---------- glossary ----------

function loadGlossary(lang) {
  const file = path.resolve(`content/glossary/${lang}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reviewerPresent = Boolean(raw.reviewedBy && raw.reviewedAt);

  const entryStatus = (entry) =>
    reviewerPresent && entry.status === 'VERIFIED'
      ? TRANSLATION_STATUS.VERIFIED
      : TRANSLATION_STATUS.UNVERIFIED;

  // `tr` is the translation in the file's own language; `kn` is accepted for
  // older entries where the key was named after the language.
  const tr = (e) => e.tr ?? e.kn;

  const phrases = new Map();
  const terms = new Map();
  for (const e of raw.phrases || []) {
    phrases.set(normalize(e.en), { en: e.en, tr: tr(e), status: entryStatus(e) });
  }
  for (const e of raw.terms || []) {
    terms.set(normalize(e.en), { en: e.en, tr: tr(e), status: entryStatus(e) });
  }
  return {
    language: raw.language,
    languageName: raw.languageName,
    contentVersion: raw.contentVersion,
    reviewed: reviewerPresent,
    phrases,
    terms,
    all: [...phrases.values(), ...terms.values()],
  };
}

const glossaries = new Map();
for (const lang of ['kn', 'hi']) {
  const g = loadGlossary(lang);
  if (g) glossaries.set(lang, g);
}

export const glossarySummary = () =>
  [...glossaries.values()].map((g) => ({
    language: g.language,
    languageName: g.languageName,
    contentVersion: g.contentVersion,
    reviewed: g.reviewed,
    entries: g.all.length,
  }));

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordCount = (t) => normalize(t).split(' ').filter(Boolean).length;

/** Terms that appear in a sentence — used for AI hints and clarification tracking. */
export function termsIn(text, lang = 'kn') {
  const g = glossaries.get(lang);
  if (!g) return [];
  const n = ` ${normalize(text)} `;
  const hits = [];
  for (const entry of g.terms.values()) {
    if (n.includes(` ${normalize(entry.en)} `)) hits.push(entry);
  }
  return hits;
}

/**
 * Local-only lookup. Returns null when the glossary cannot render the sentence.
 * Longest phrase win: a whole-phrase entry beats individual word rendering.
 */
function lookupGlossary(text, lang) {
  const g = glossaries.get(lang);
  if (!g) return null;
  const n = normalize(text);
  if (!n) return null;

  const phrase = g.phrases.get(n) || g.terms.get(n);
  if (phrase) {
    return {
      translation: phrase.tr,
      status: phrase.status,
      source: 'glossary:phrase',
      terms: [phrase],
    };
  }

  // Sentence assembly: replace known terms/phrases, keep the rest in English and
  // say so honestly — this is a partial rendering, never a full translation claim.
  let out = String(text);
  const matched = [];
  const candidates = [...g.phrases.values(), ...g.terms.values()].sort(
    (a, b) => b.en.length - a.en.length
  );
  for (const entry of candidates) {
    const re = new RegExp(`(^|[^\\p{L}])${escapeRe(entry.en)}([^\\p{L}]|$)`, 'giu');
    if (re.test(out)) {
      out = out.replace(re, (m, pre, post) => `${pre}${entry.tr}${post}`);
      matched.push(entry);
    }
  }
  if (!matched.length) return null;

  const total = wordCount(text);
  const covered = matched.reduce((acc, m) => acc + wordCount(m.en), 0);
  const coverage = Math.min(1, covered / Math.max(1, total));
  return {
    translation: out,
    // This is a generated assembly, not a reviewed translation.
    status: TRANSLATION_STATUS.UNVERIFIED,
    source: 'glossary:partial',
    terms: matched,
    coverage: Math.round(coverage * 100) / 100,
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- AI usage accounting ----------

export function recordAiUsage({ sessionId, operation, outcome, latencyMs = null, detail = null }) {
  db.prepare(
    'INSERT INTO ai_usage (session_id, operation, outcome, latency_ms, detail, ts) VALUES (?,?,?,?,?,?)'
  ).run(sessionId || null, operation, outcome, latencyMs, detail ? String(detail).slice(0, 300) : null, Date.now());
}

export function aiUsageStats(sessionId = null) {
  const where = sessionId ? 'WHERE session_id = ?' : '';
  const args = sessionId ? [sessionId] : [];
  const rows = db
    .prepare(`SELECT operation, outcome, COUNT(*) AS n FROM ai_usage ${where} GROUP BY operation, outcome`)
    .all(...args);
  const pick = (op, outcome) =>
    rows.find((r) => r.operation === op && r.outcome === outcome)?.n || 0;

  const glossaryLookups = pick('translate', 'glossary');
  const aiRequests = pick('translate', 'ai_request');
  const aiSuccess = pick('translate', 'ai_success');
  const aiFailure = pick('translate', 'ai_failure');
  const fallback = pick('translate', 'fallback');
  const total = glossaryLookups + aiSuccess + fallback;
  return {
    glossaryLookups,
    aiRequests,
    aiSuccess,
    aiFailure,
    fallback,
    translationsServed: total,
    // Only meaningful when at least one translation was actually served.
    glossaryShare: total ? Math.round((glossaryLookups / total) * 1000) / 10 : null,
  };
}

// ---------- pipeline ----------

/**
 * Resolve a translation for one message.
 * Order: verified/known glossary → AI provider → original text with FALLBACK.
 * Never throws: a failure is a reported state, not an interrupted session.
 */
export async function translate({ text, lang = 'kn', sessionId = null, provider = null }) {
  const started = Date.now();
  const local = lookupGlossary(text, lang);

  if (local && local.status === TRANSLATION_STATUS.VERIFIED) {
    recordAiUsage({ sessionId, operation: 'translate', outcome: 'glossary', detail: 'verified' });
    return { ...local, latencyMs: Date.now() - started };
  }

  const canUseAi = provider && provider.available();
  if (!canUseAi) {
    if (local) {
      recordAiUsage({ sessionId, operation: 'translate', outcome: 'glossary', detail: local.source });
      return { ...local, latencyMs: Date.now() - started };
    }
    recordAiUsage({ sessionId, operation: 'translate', outcome: 'fallback', detail: 'ai unavailable' });
    return {
      translation: null,
      status: TRANSLATION_STATUS.FALLBACK,
      source: 'none',
      terms: [],
      reason: 'ai_unavailable',
      latencyMs: Date.now() - started,
    };
  }

  recordAiUsage({ sessionId, operation: 'translate', outcome: 'ai_request' });
  try {
    const result = await provider.translate({
      text,
      sourceLang: 'en',
      targetLang: lang,
      glossaryHints: local?.terms?.map((t) => ({ en: t.en, kn: t.tr })) || [],
    });
    recordAiUsage({
      sessionId,
      operation: 'translate',
      outcome: 'ai_success',
      latencyMs: result.latencyMs,
      detail: result.model,
    });
    return {
      translation: result.translation,
      status: TRANSLATION_STATUS.AI_TRANSLATION,
      source: 'ai',
      model: result.model,
      terms: local?.terms || [],
      latencyMs: result.latencyMs,
    };
  } catch (err) {
    recordAiUsage({
      sessionId,
      operation: 'translate',
      outcome: 'ai_failure',
      latencyMs: err.latencyMs ?? Date.now() - started,
      detail: err.message,
    });
    log.warn('translation provider failed', { reason: err.message });
    if (local) return { ...local, latencyMs: Date.now() - started, aiFailed: true };
    recordAiUsage({ sessionId, operation: 'translate', outcome: 'fallback', detail: 'no glossary match' });
    return {
      translation: null,
      status: TRANSLATION_STATUS.FALLBACK,
      source: 'none',
      terms: [],
      reason: err instanceof AIUnavailableError ? err.message : 'provider_error',
      latencyMs: Date.now() - started,
    };
  }
}

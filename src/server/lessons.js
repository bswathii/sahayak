// lessons.js — activity-independent lesson pack loader.
// A pack is plain JSON so new activities can be added without touching code.
// Every pack carries the same ten-stage pathway; only its prompts and text change.
import fs from 'node:fs';
import path from 'node:path';
import { STAGE_IDS } from './protocol.js';

const DIR = path.resolve('content/lessons');

function validate(pack, file) {
  const problems = [];
  if (!pack.id) problems.push('id');
  if (!pack.title) problems.push('title');
  if (!pack.objective) problems.push('objective');
  if (!Array.isArray(pack.stages) || pack.stages.length !== STAGE_IDS.length) {
    problems.push(`stages (expected ${STAGE_IDS.length})`);
  }
  for (const [i, s] of (pack.stages || []).entries()) {
    if (!s.id) problems.push(`stages[${i}].id`);
    if (s.id && STAGE_IDS[i] !== s.id) problems.push(`stages[${i}].id (expected ${STAGE_IDS[i]})`);
    if (!s.title?.en) problems.push(`stages[${i}].title.en`);
    if (!s.prompt?.en) problems.push(`stages[${i}].prompt.en`);
  }
  if (!pack.i18n?.en?.title) problems.push('i18n.en.title');
  if (typeof pack.contentVersion !== 'number') problems.push('contentVersion');
  if (problems.length) {
    throw new Error(`lesson pack ${file} is invalid: missing ${problems.join(', ')}`);
  }
  return pack;
}

function loadAll() {
  if (!fs.existsSync(DIR)) return new Map();
  const packs = new Map();
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const pack = validate(JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')), file);
      packs.set(pack.id, pack);
    } catch (err) {
      // A broken pack must not stop the classroom from starting.
      console.error(`[lessons] ${err.message}`);
    }
  }
  return packs;
}

let cache = loadAll();

export function listLessons() {
  return [...cache.values()].map((p) => ({
    id: p.id,
    title: p.title,
    objective: p.objective,
    label: p.label || null,
    category: p.category || null,
    contentVersion: p.contentVersion,
    languages: p.languages || ['en'],
    stageCount: p.stages.length,
    translationStatus: p.translationStatus || 'UNVERIFIED',
  }));
}

export function getLesson(id) {
  return cache.get(id) || null;
}

export function defaultLesson() {
  return cache.values().next().value || null;
}

/** Cache-busting version token for the service worker. */
export function contentVersionToken() {
  return [...cache.values()]
    .map((p) => `${p.id}@${p.contentVersion}`)
    .sort()
    .join('|');
}

export function reloadLessons() {
  cache = loadAll();
  return cache.size;
}

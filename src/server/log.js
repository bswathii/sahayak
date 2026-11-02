// log.js — structured application logs. Never log secrets or free-text student content.
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? 20;
const REDACT = ['apikey', 'api_key', 'authorization', 'gemini_api_key', 'token'];

function scrub(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT.includes(k.toLowerCase())) out[k] = '[redacted]';
    else if (v && typeof v === 'object') out[k] = scrub(v);
    else out[k] = v;
  }
  return out;
}

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const record = { ts: new Date().toISOString(), level, msg, ...scrub(fields) };
  const line =
    config.logFormat === 'pretty'
      ? `${record.ts} ${level.toUpperCase().padEnd(5)} ${msg} ${Object.keys(fields).length ? JSON.stringify(scrub(fields)) : ''}`
      : JSON.stringify(record);
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg, f) => emit('debug', msg, f),
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),
};

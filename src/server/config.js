// config.js — all configuration comes from environment variables.
import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependency). Existing process env wins.
const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bool = (v, dflt) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(String(v)));

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  databasePath: process.env.DATABASE_PATH || './data/sahayak.db',
  logFormat: (process.env.LOG_FORMAT || 'json').toLowerCase(),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  ai: {
    provider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
    enabled: bool(process.env.AI_ENABLED, true),
    apiKey: process.env.GEMINI_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    model: (process.env.AI_PROVIDER || 'gemini') === 'qwen'
      ? process.env.QWEN_MODEL || 'qwen-max'
      : process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    baseUrl: (process.env.AI_PROVIDER || 'gemini') === 'qwen'
      ? process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-api/v1'
      : undefined,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 8000),
  },
  // Application-level payload cap experiment (Section 6E). 0 = disabled.
  payloadCapBps: Number(process.env.PAYLOAD_CAP_BPS || 0),
  protocolVersion: 1,
};

export const isAiConfigured = () =>
  config.ai.enabled && 
  (config.ai.provider === 'gemini' || config.ai.provider === 'qwen') &&
  ((config.ai.provider === 'gemini' && config.ai.apiKey.length > 0) ||
   (config.ai.provider === 'qwen' && config.ai.apiKey.length > 0));

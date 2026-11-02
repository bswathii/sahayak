// ai/gemini.js — the only implemented AIProvider adapter.
// Key stays server-side (env). Every call has a timeout and structured errors.
import { config } from '../config.js';
import { AIUnavailableError } from './provider.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function assertAvailable() {
  if (!config.ai.enabled) {
    throw new AIUnavailableError('AI disabled by AI_ENABLED=false (kill-switch)');
  }
  if (config.ai.provider !== 'gemini') {
    throw new AIUnavailableError(`unsupported AI_PROVIDER "${config.ai.provider}"`);
  }
  if (!config.ai.apiKey) {
    throw new AIUnavailableError('GEMINI_API_KEY is not set');
  }
}

async function generate({ prompt, systemInstruction, maxOutputTokens = 400, json = false }) {
  assertAvailable();
  const url = `${API_BASE}/${encodeURIComponent(config.ai.model)}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header auth keeps the key out of URLs, logs and browser memory.
        'x-goog-api-key': config.ai.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
  } catch (err) {
    const reason =
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? 'timeout'
        : `network error: ${err.message}`;
    throw Object.assign(new AIUnavailableError(reason), { latencyMs: Date.now() - started });
  }

  const latencyMs = Date.now() - started;
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error?.message || '';
    } catch {
      /* ignore */
    }
    throw Object.assign(
      new AIUnavailableError(`provider HTTP ${res.status}${detail ? `: ${detail}` : ''}`),
      { latencyMs, status: res.status }
    );
  }

  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) {
    throw Object.assign(new AIUnavailableError('empty provider response'), { latencyMs });
  }
  return { text, latencyMs, model: config.ai.model };
}

function stripFences(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

export const geminiProvider = {
  name: 'gemini',
  available() {
    try {
      assertAvailable();
      return true;
    } catch {
      return false;
    }
  },

  async translate({ text, sourceLang = 'en', targetLang = 'kn', glossaryHints = [] }) {
    const hints = glossaryHints.length
      ? `Use these approved glossary renderings where they apply: ${glossaryHints
          .map((h) => `"${h.en}" => "${h.kn}"`)
          .join('; ')}.`
      : '';
    const prompt = `Translate the following classroom sentence from ${sourceLang} to ${targetLang}.
Return only the translation, no quotes, no explanation. Keep it short and suitable for a rural school student.
${hints}
Sentence: ${text}`;
    const out = await generate({
      prompt,
      systemInstruction:
        'You translate short learning-assistance messages. Preserve meaning; never add advice that was not in the source.',
      maxOutputTokens: 200,
    });
    return { translation: stripFences(out.text), latencyMs: out.latencyMs, model: out.model };
  },

  async summarizeHandoff({ evidence }) {
    const prompt = `You write handoff notes for volunteer teachers. Use ONLY the evidence JSON below.
Do not invent student understanding, answers, or events. If the evidence is insufficient for a claim, say so.
Evidence JSON:
${JSON.stringify(evidence)}

Return JSON: {"summary": string (max 900 chars, plain sentences), "suggestedNextInteraction": string (max 220 chars)}`;
    const out = await generate({
      prompt,
      systemInstruction:
        'You summarise recorded learning sessions for the next volunteer. Never fabricate evidence of understanding.',
      maxOutputTokens: 700,
      json: true,
    });
    let parsed;
    try {
      parsed = JSON.parse(stripFences(out.text));
    } catch {
      throw Object.assign(new AIUnavailableError('provider returned malformed JSON'), {
        latencyMs: out.latencyMs,
      });
    }
    return {
      summary: String(parsed.summary || '').slice(0, 1200),
      suggestedNextInteraction: String(parsed.suggestedNextInteraction || '').slice(0, 300),
      latencyMs: out.latencyMs,
      model: out.model,
    };
  },

  async coachingTips({ evidence }) {
    const prompt = `You give private, indicative coaching suggestions to a volunteer after a session.
Use ONLY this evidence JSON. Do not rank volunteers, do not assign teaching-quality scores.
Evidence JSON:
${JSON.stringify(evidence)}

Return JSON: {"tips":[{"text": string, "rationale": string}]} with at most 4 tips.`;
    const out = await generate({
      prompt,
      systemInstruction:
        'You suggest concrete next teaching actions grounded in recorded session events only. No scores, no rankings.',
      maxOutputTokens: 700,
      json: true,
    });
    let parsed;
    try {
      parsed = JSON.parse(stripFences(out.text));
    } catch {
      throw Object.assign(new AIUnavailableError('provider returned malformed JSON'), {
        latencyMs: out.latencyMs,
      });
    }
    const tips = Array.isArray(parsed.tips) ? parsed.tips.slice(0, 4) : [];
    return {
      tips: tips.map((t) => ({
        text: String(t.text || '').slice(0, 300),
        rationale: String(t.rationale || '').slice(0, 300),
      })),
      latencyMs: out.latencyMs,
      model: out.model,
    };
  },
};

// ai/provider.js — the model-agnostic AIProvider interface.
// The classroom never imports a vendor SDK directly; it only sees this shape.

export class AIUnavailableError extends Error {
  constructor(reason) {
    super(reason);
    this.code = 'ai_unavailable';
  }
}

/**
 * @typedef {object} AIProvider
 * @property {string} name
 * @property {() => boolean} available
 * @property {(input:{text:string,sourceLang:string,targetLang:string,glossaryHints:Array<{en:string,kn:string}>}) => Promise<string>} translate
 * @property {(input:{evidence:object}) => Promise<{summary:string,suggestedNextInteraction:string}>} summarizeHandoff
 * @property {(input:{evidence:object}) => Promise<Array<{text:string,rationale:string}>>} coachingTips
 */

/** Used when AI is disabled, unconfigured, or the provider is unknown. */
export const nullProvider = {
  name: 'none',
  available: () => false,
  async translate() {
    throw new AIUnavailableError('no AI provider configured');
  },
  async summarizeHandoff() {
    throw new AIUnavailableError('no AI provider configured');
  },
  async coachingTips() {
    throw new AIUnavailableError('no AI provider configured');
  },
};

/** Qwen provider for DashScope-compatible API. */
export const qwenProvider = {
  name: 'qwen',
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
    const out = await qwenGenerate({
      prompt,
      systemInstruction:
        'You translate short learning-assistance messages. Preserve meaning; never add advice that was not in the source.',
      maxOutputTokens: 200,
    });
    return { translation: out.text, latencyMs: out.latencyMs, model: out.model };
  },

  async summarizeHandoff({ evidence }) {
    const prompt = `You write handoff notes for volunteer teachers. Use ONLY the evidence JSON below.
Do not invent student understanding, answers, or events. If the evidence is insufficient for a claim, say so.
Evidence JSON:
${JSON.stringify(evidence)}

Return JSON: {"summary": string (max 900 chars, plain sentences), "suggestedNextInteraction": string (max 220 chars)}`;
    const out = await qwenGenerate({
      prompt,
      systemInstruction:
        'You summarise recorded learning sessions for the next volunteer. Never fabricate evidence of understanding.',
      maxOutputTokens: 700,
      json: true,
    });
    let parsed;
    try {
      parsed = JSON.parse(out.text);
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
    const out = await qwenGenerate({
      prompt,
      systemInstruction:
        'You suggest concrete next teaching actions grounded in recorded session events only. No scores, no rankings.',
      maxOutputTokens: 700,
      json: true,
    });
    let parsed;
    try {
      parsed = JSON.parse(out.text);
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

function assertAvailable() {
  if (!config.ai.enabled) {
    throw new AIUnavailableError('AI disabled by AI_ENABLED=false (kill-switch)');
  }
  if (config.ai.provider !== 'qwen') {
    throw new AIUnavailableError(`unsupported AI_PROVIDER "${config.ai.provider}"`);
  }
  if (!config.ai.apiKey) {
    throw new AIUnavailableError('DASHSCOPE_API_KEY is not set');
  }
}

async function qwenGenerate({ prompt, systemInstruction, maxOutputTokens = 400, json = false }) {
  assertAvailable();
  const url = `${config.ai.baseUrl}/models/${config.ai.model}:generateContent`;
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

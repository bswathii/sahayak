# API_CONTRACTS.md — Sahayak AI Qwen Integration

## Existing API Routes (Preserved)
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness: database, AI configuration, content version |
| GET | `/api/meta` | Protocol version, AI state (never the key), glossary summary, lifecycle states |
| GET | `/api/lessons` | Lesson listing + content version token |
| GET | `/api/lessons/:id` | Full lesson pack (cached by the service worker) |
| POST | `/api/sessions` | `{topic, language, lessonId}` → 201 `{session, lesson}` |
| GET | `/api/sessions/:code` | Session, lesson, match candidates (when OPEN), transitions, AI usage |
| GET | `/api/sessions/:code/bundle` | Session + lesson + transitions + events + interactions + latest handoff |
| POST | `/api/sessions/:code/match` | Ranked volunteers with explicit reasons |
| POST | `/api/sessions/:code/transition` | `{to, actor?, volunteerId?, meta?}` |
| GET | `/api/sessions/:code/interactions` | Student observations |
| POST | `/api/sessions/:code/assessments` | `{itemId, response}` → correctness + explanation |
| POST | `/api/sessions/:code/handoff` | Generate handoff from persisted events |
| GET | `/api/sessions/:code/handoff` | Latest handoff |
| POST | `/api/sessions/:code/coaching` | Private, indicative coaching suggestions |
| GET | `/api/sessions/:code/ai-usage` | Glossary vs AI vs fallback counts for this session |
| GET | `/api/ai/stats` | Aggregate AI usage |

## Qwen Provider Interface (New)

### Environment Variables (add to .env.example)
```
DASHSCOPE_API_KEY=      # Qwen API key (backend only, never in browser)
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-api/v1  # region-specific
QWEN_MODEL=qwen-max     # configurable model identifier
QWEN_TIMEOUT_MS=8000    # request timeout
```

### Provider Initialization (src/server/ai/provider.js extension)
The Qwen provider must conform to the `AIProvider` shape defined in `src/server/ai/provider.js`:
- `name: 'qwen'`
- `available(): boolean` — checks `config.ai.enabled`, `config.ai.provider === 'qwen'`, `config.ai.apiKey.length > 0`
- `translate({ text, sourceLang = 'en', targetLang = 'kn', glossaryHints })` → `Promise<{translation:string,latencyMs:number,model:string}>`
- `summarizeHandoff({ evidence })` → `Promise<{summary:string,suggestedNextInteraction:string,latencyMs:number,model:string}>`
- `coachingTips({ evidence })` → `Promise<{tips:{text:string,rationale:string}[]}>`

### Qwen Chat Completions API
```
POST {QWEN_BASE_URL}/models/{QWEN_MODEL}:generateContent
Headers:
  content-type: application/json
  x-goog-api-key: {DASHSCOPE_API_KEY}  # never exposed to browser
Body:
{
  contents: [{role: 'user', parts: [{text: {prompt}}]}],
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 400
  }
}
```

### Error Handling
- `AIUnavailableError` thrown when key missing, provider misconfigured, or HTTP error
- Timeout via `AbortSignal.timeout(config.ai.timeoutMs)`
- Rate limits: bounded retry (max 2 attempts, exponential backoff)
- Malformed JSON from provider → `AIUnavailableError('provider returned malformed JSON')`
- Never expose `DASHSCOPE_API_KEY` in any client response, log, or error message

### AI Usage Accounting (append to `ai_usage` table)
- `operation`: 'translate' | 'summarize_handoff' | 'coaching_tips'
- `outcome`: 'success' | 'failure' | 'skipped' | 'fallback'
- `latency_ms`: request duration
- `detail`: model name or error reason

### Qwen translate prompt template
```
Translate the following classroom sentence from {sourceLang} to {targetLang}.
Return only the translation, no quotes, no explanation. Keep it short and suitable for a rural school student.
Use these approved glossary renderings where they apply: {glossaryHints}.
Sentence: {text}
```

### Qwen summarize handoff prompt template
```
You write handoff notes for volunteer teachers. Use ONLY the evidence JSON below.
Do not invent student understanding, answers, or events. If the evidence is insufficient for a claim, say so.
Evidence JSON:
{JSON.stringify(evidence)}
Return JSON: {"summary": string (max 900 chars, plain sentences), "suggestedNextInteraction": string (max 220 chars)}
```

### Qwen coaching tips prompt template
```
You give private, indicative coaching suggestions to a volunteer after a session.
Use ONLY this evidence JSON. Do not rank volunteers, do not assign teaching-quality scores.
Evidence JSON:
{JSON.stringify(evidence)}
Return JSON: {"tips":[{"text": string, "rationale": string}]} with at most 4 tips.
```

## WebSocket Message Structure (Preserved)
- Same as existing: `hello`, `ping`, `send`, `welcome`, `hello.ok`, `snapshot`, `replay`, `event`, `ack`, `duplicate`, `presence`, `pong`, `error`
- New types may be added by Qwen integration but must not conflict with existing contract

## Database Contracts (Preserved + Extended)
- `ai_usage` table already exists — Qwen operations append here
- No schema changes needed; all Qwen metadata stored in existing JSON columns or new rows
- `events` table unchanged — Qwen-assisted events follow same `eventId`/`seq` contracts

## Error Codes (Existing + New)
Existing codes remain: `bad_version`, `bad_role`, `no_session`, `not_joined`, `session_closed`, `bad_json`, `bad_frame`, `unknown_frame`, `unknown_type`, `reserved_type`, `bad_event_id`, `bad_client_seq`, `bad_payload`, `empty_text`, `text_too_long`, `bad_lang`, `bad_points`, `too_many_points`, `bad_point`, `bad_stroke_id`, `bad_result`, `bad_step`, `role_forbidden`, `rate_limited`, `internal`.

New error situations (returned as `{ error: { code, message } }`):
- `ai_unavailable` — AI disabled, unconfigured, or provider key missing
- `ai_rate_limited` — too many consecutive Qwen requests (client-facing, not thrown internally)
- `ai_provider_error` — HTTP error from Qwen service
- `ai_malformed_response` — provider returned invalid JSON

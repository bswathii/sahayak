# API_CONTRACTS.md — Sahayak

Protocol version: **1** (`v: 1` on every frame and event).
Labels used below: IMPLEMENTED · SIMULATED · FUTURE ROADMAP · DEFERRED — ACTIVITY SELECTION.

Single source of truth in code: `src/server/protocol.js`.

---

## 1. Identifiers

| Term | Meaning | Rule |
|---|---|---|
| `sessionId` | Server-generated UUID for a learning session | Never chosen by a client |
| `code` | 6-character join handle (`A-Z2-9`, no `I/O/0/1`) | IMPLEMENTED. A join handle, **not authentication** |
| `deviceId` | Random per-browser identifier from `localStorage` | IMPLEMENTED. No name, phone or account is collected |
| `eventId` | Unique id generated **once by the sender** | 8–64 chars `[A-Za-z0-9_-]`. Used for deduplication |
| `seq` | Monotonic integer assigned **once by the server** | Unique per session. Used for ordering and replay |

`eventId` and `seq` are **not interchangeable**: an event may be retried with the same `eventId`, but it never receives a second `seq`.

---

## 2. WebSocket transport

- Endpoint: `GET /ws` (same origin, no subprotocol negotiation).
- Text frames only; binary frames are rejected (`bad_frame`).
- `perMessageDeflate` is disabled so payload measurement reflects the application's bytes.
- Inbound JSON frame limit: **8192 bytes** (`maxPayload`).
- Heartbeat: server pings every 30 s; dead sockets are terminated.

### 2.1 Client → server frames

| `t` | Purpose |
|---|---|
| `hello` | Handshake (below) |
| `ping` | Latency sample. `{ t:'ping', clientTs:<ms> }` |
| `send` | Carries one event: `{ t:'send', event:{ v, type, eventId, payload, clientSeq? } }` |
| `bye` | Client-initiated close |

`hello` — IMPLEMENTED:

```json
{ "t": "hello", "v": 1, "role": "student", "code": "K7QM2P",
  "deviceId": "dev-3f9a1c22", "since": 42 }
```

`since` is the last `seq` the client already processed. `0` (or omitted) asks for the full history.

### 2.2 Server → client frames

| `t` | Meaning |
|---|---|
| `welcome` | Sent on connect: protocol version, server time, heartbeat interval |
| `hello.ok` | Handshake accepted: assigned `deviceId`, `sessionId`, `lastSeq` |
| `snapshot` | Session record **and** the full lesson pack (cacheable, no secrets) |
| `replay` | `{ t:'replay', events:[...] }` — events after `since`, in `seq` order |
| `event` | `{ t:'event', event:{...} }` — one relayed, persisted event |
| `ack` | `{ t:'ack', eventId, seq }` — the event is durably stored |
| `duplicate` | The same `eventId` was already stored; not re-broadcast |
| `presence` | Connected client counts plus current `seq` |
| `pong` | Reply to `ping` and to `measure.ping` |
| `error` | `{ t:'error', code, message, eventId? }` |

### 2.3 Error codes (IMPLEMENTED)

`bad_version`, `bad_role`, `no_session`, `not_joined`, `session_closed`, `bad_json`, `bad_frame`,
`unknown_frame`, `unknown_type`, `reserved_type`, `bad_event_id`, `bad_client_seq`, `bad_payload`,
`empty_text`, `text_too_long`, `bad_lang`, `bad_points`, `too_many_points`, `bad_point`,
`bad_stroke_id`, `bad_result`, `bad_step`, `role_forbidden`, `rate_limited`, `internal`.

---

## 3. Event envelope

Every persisted event, as delivered:

```json
{
  "v": 1,
  "type": "text.message",
  "eventId": "3f2e6b8a-...",
  "sessionId": "7d1c...",
  "seq": 17,
  "actor": { "role": "student", "deviceId": "dev-3f9a1c22" },
  "ts": 1761960000123,
  "payload": { "text": "Hello", "targetLang": "kn" }
}
```

`actor.role` ∈ `student | volunteer | server | system`.

---

## 4. Implemented events (client → server)

### `text.message`
```json
{ "text": "string, ≤500 chars, required", "targetLang": "kn" }
```
Broadcast immediately and persisted. **Translation is never awaited** — see §5.

### `stroke.chunk`
```json
{ "strokeId": "s-ab12cd34", "color": "#7fe3ff", "width": 3,
  "points": [[0.1234, 0.5678], ...], "first": true, "last": false }
```
- Points are **normalised 0..1** and quantised to 4 decimals, so geometry is resolution-independent.
- At most 240 points per chunk; coordinates outside 0..1 are clamped.
- Volunteer role only (`role_forbidden` otherwise).
- Batching: the client flushes a chunk at most every ~100 ms while drawing.
- Not an image, not a canvas snapshot: no `image` field exists in the contract.

### `board.clear`
`{}` — volunteer only.

### `interaction.response`
```json
{ "result": "need_help", "stepId": "step-2", "note": null }
```
`result` ∈ `it_works | it_does_not_work | im_stuck | need_help | try_again`. Student role only.
These are **student-reported observations**, not measurements of learning.

### `lesson.step`
`{ "stepId": "step-2" }` — moves the shared pointer for the current lesson step.

### `measure.ping`
`{ "clientTs": 1761960000123 }` — **ephemeral**: never persisted, never replayed; answered with `pong`.

---

## 5. Server-generated events (pushed, persisted)

### `text.translation`
Emitted after a `text.message`, asynchronously, and stored so reconnecting clients see it.

```json
{ "forEventId": "<eventId of the message>", "forSeq": 17, "lang": "kn",
  "text": "Hello", "translation": "ನಮಸ್ಕಾರ", "status": "UNVERIFIED",
  "source": "glossary:phrase | glossary:partial | ai | none",
  "terms": [{ "en": "force", "kn": "ಬಲ", "status": "UNVERIFIED" }],
  "reason": null, "model": null, "latencyMs": 1 }
```

`status` ∈ `VERIFIED | UNVERIFIED | AI_TRANSLATION | FALLBACK`.
`translation: null` with `status: "FALLBACK"` means the original text stands alone.
`source: "glossary:partial"` means only glossary terms were replaced; the client labels it as partial.

### `session.state`
```json
{ "from": "OFFERED", "to": "ACCEPTED",
  "meta": { "volunteerId": "vol-ananya", "volunteerName": "Ananya R." } }
```

### `handoff.created`
```json
{ "handoffId": "uuid", "aiStatus": "AI_GENERATED | FALLBACK_DETERMINISTIC",
  "evidenceLevel": "none | minimal | partial" }
```

### `assessment.response` (appended server-side via HTTP)
```json
{ "itemId": "test-q1", "response": "3", "isCorrect": true }
```

### `presence` (not persisted)
```json
{ "t": "presence", "sessionId": "...", "connected": 2, "students": 1, "volunteers": 1, "seq": 42 }
```

---

## 6. Ordering, deduplication, reconnection

1. The server assigns `seq = MAX(seq) + 1` inside a transaction; `UNIQUE(session_id, seq)` is the backstop.
2. Broadcast order is `seq` order.
3. A client keeps a set of seen `eventId`s and a `lastSeq` cursor.
   - Repeated `eventId` → `duplicate` frame, no re-broadcast, no new `seq`.
   - `seq` gap while connected → client closes the socket and reconnects with `since: lastSeq`.
4. On `hello` with `since > 0`, the server replies with `snapshot`, then `replay` carrying only `seq > since`.
5. Duplicate suppression is also enforced in the browser (`classroom.js`), so a replayed frame never renders twice.
6. **Measured:** reconnect replayed exactly the missed events and nothing the client already had
   (`test/smoke.test.js`).

Client-sent `clientSeq` is accepted and stored for diagnostics only. It never influences ordering.

---

## 7. Session lifecycle

`OPEN → OFFERED → ACCEPTED → SESSION → FEEDBACK → CLOSED`

| From | Allowed |
|---|---|
| OPEN | OFFERED |
| OFFERED | ACCEPTED, OPEN |
| ACCEPTED | SESSION, OPEN |
| SESSION | FEEDBACK |
| FEEDBACK | CLOSED |
| CLOSED | — |

Every transition writes a `session.state` event **and** a row in `session_transitions`
(`session_id, from_state, to_state, actor, event_id, seq, ts, meta`). Invalid transitions return
HTTP 400 `invalid_transition` and persist nothing. IMPLEMENTED.

---

## 8. HTTP API (all IMPLEMENTED)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness: database, AI configuration, content version |
| GET | `/api/meta` | Protocol version, AI state (never the key), glossary summary, lifecycle states |
| GET | `/api/lessons` | Lesson listing + content version token |
| GET | `/api/lessons/:id` | Full lesson pack (cached by the service worker) |
| POST | `/api/sessions` | `{topic, language, lessonId}` → 201 `{session, lesson}` |
| GET | `/api/sessions/:code` | Session, lesson, match candidates (when OPEN), transitions, AI usage |
| GET | `/api/sessions/:code/bundle` | Session + lesson + transitions + events + interactions + latest handoff (second-volunteer continuity) |
| POST | `/api/sessions/:code/match` | Ranked volunteers with explicit reasons |
| POST | `/api/sessions/:code/transition` | `{to, actor?, volunteerId?, meta?}` |
| GET | `/api/sessions/:code/interactions` | Student observations |
| POST | `/api/sessions/:code/assessments` | `{itemId, response}` → correctness + explanation |
| POST | `/api/sessions/:code/handoff` | Generate handoff from persisted events |
| GET | `/api/sessions/:code/handoff` | Latest handoff |
| POST | `/api/sessions/:code/coaching` | Private, indicative coaching suggestions |
| GET | `/api/sessions/:code/ai-usage` | Glossary vs AI vs fallback counts for this session |
| GET | `/api/ai/stats` | Aggregate AI usage |

Errors: `{ "error": { "code": "...", "message": "..." } }` with 400/404/500.

---

## 9. Limits and guards (IMPLEMENTED)

| Guard | Value |
|---|---|
| Frame size | 8192 bytes |
| Text message | 500 characters |
| Points per stroke chunk | 240 |
| Message rate per socket | 120 per 10 s |
| Student observations | 40 per minute |
| Body size (HTTP JSON) | 16 kB |
| Role rules | Only volunteers draw; only students record observations |

A **session code is not authentication**. Anyone holding the code can join; this is documented as a prototype limitation.

---

## 10. Future hardware interface — FUTURE ROADMAP (not implemented)

Reserved and rejected today with `reserved_type`:

| Type | Intended meaning |
|---|---|
| `device.status` | Future kit reports its state |
| `device.command` | Server/volunteer requests a kit action |
| `device.ack` | Kit confirms a command |

No sensor values, GPIO numbers, motor identifiers or telemetry fields exist in this build, and none should be invented. Hardware integration waits for an activity and a hardware architecture to be selected.

---

## 11. Assessment contract — DEFERRED — ACTIVITY SELECTION

The structure is implemented and exercised with clearly-labelled temporary test content:

```json
{ "id": "test-q1", "stage": "pre|post", "objective": "...", "question": "...",
  "options": ["..."], "correctIndex": 1, "explanation": "..." }
```

Responses persist in `assessment_responses` with `is_correct` nullable (questions without an objective
answer key record a response and no correctness). No activity-specific questions exist yet, and no
learning-improvement claim is supported by the current build.

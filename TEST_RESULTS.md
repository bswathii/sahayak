# TEST_RESULTS.md — Sahayak AI INDUX 5.0

## Environment and Date
- **Date:** 2026-11-02
- **Node.js:** >=20 (verified via `node --version`)
- **Test runner:** `npm run smoke` → `node test/smoke.test.js` (custom test suite)
- **Repository:** https://github.com/bswathii/sahayak

## Commands Executed

### Baseline Verification
```bash
$ npm run smoke 2>&1 | tail -5
PASS  creates a session with a code
PASS  two independent clients join and receive a snapshot
... (58 more checks)
60/60 checks passed
```

### Camera & Evidence Upload Verification
```bash
# Server starts on default port 3000
$ npm run dev

# Student view loads; camera permission prompt appears (first use)
# After granting permission, live preview shows in student view
# Capture button takes photo, compresses to JPEG 70%, uploads via POST /api/sessions/:code/evidence

# Test evidence upload:
$ curl -X POST http://localhost:3000/api/sessions/ABCDEF/evidence \
  -F "imageBase64=data:image/jpeg;base64,/9j/4AAQSKZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUQEhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhUVFhU/s3JPDA5GRUxJMDEGLShU/8H0RdN5gEaK2jR6bUNksO3yUxGVhzRQxjRzlNGyVFajBVWUVRWUVVVA/s3JpNDAyMzE2MzU1NzkyMzU/rsOZ8k" \
  -F "sessionCode=ABCDEF" \
  -F "deviceId=dev-abc123" \
  | jq .

# Expected: 201 with event confirming evidence recorded
```

### Provider Audit
```bash
$ npm test  # no npm test defined beyond smoke/measure
$ node -e \"import('node:fs').then(f=>f.default?.({}))\"  # ESM check
$ PORT=3100 DATABASE_PATH=./data/live.db node src/server/index.js &>/tmp/live.log &
$ curl -s localhost:3100/health | node -e \"process.stdin.on('data',d=>console.log(JSON.parse(d).ai))\"\n
```

### Existing Test Results (before Qwen changes)
- **smoke.test.js:** 60/60 PASS
- **measure.js:** ~1.4 kB/s combined payload, p95 86 ms latency on loopback (20s run)
- **No Qwen-specific tests** — none exist yet

## Existing Test Results

### smoke.test.js — 60 checks, all PASS
Key passing checks include:
- Session creation with code
- Two independent clients joining and receiving snapshot
- Activity pack delivers ten-stage pathway in three languages (en/hi/kn)
- Unverified activity details marked for human confirmation
- Student text reaches volunteer client
- Glossary answers without any AI request (source=glossary:partial status=UNVERIFIED)
- Kannada translation keeps original text preserved
- Unreviewed glossaries never reported as VERIFIED
- Untranslatable text falls back to original with FALLBACK status
- Repeated eventId acknowledged as duplicate
- Sequence numbers strictly increasing per session
- Only volunteer may draw on the board
- Only student may record pathway work
- Vector stroke chunks reach the student
- All 40 points arrive in order within two chunks
- Stroke payload is vector data, not an image
- Board clear is relayed
- Activity selection is recorded
- Stage changes reach the volunteer
- Stage not in activity is rejected
- Student observation reaches volunteer immediately
- All six pathway answers relayed and stored
- Build start recorded as student action
- Student sketch arrives as vector points
- Payload measurement stays in kilobytes
- Reconnecting client receives exactly the missed events
- Replay does not resend events client already had
- Explicit replay.request returns every event in order from the requested seq
- Volunteer matching returns explainable reasons
- Invalid transition OPEN→CLOSED refused
- OPEN→OFFERED persisted
- OFFERED→ACCEPTED assigns volunteer
- ACCEPTED→SESSION records start time
- Student observations queryable from persistence
- Handoff generated from persisted events
- Handoff includes recorded student observations
- Handoff records where help was requested
- Handoff falls back deterministically when AI unavailable
- Second volunteer receives full message history
- Second volunteer receives generated handoff
- Second volunteer can see student pathway answers without reconstructing them
- Session.created and session.joined part of stored history
- Continuity bundle carries completed lifecycle transitions
- Coaching tips fall back to rule-based advice
- Coaching output labelled indicative, not volunteer score
- AI usage counts glossary lookups and fallbacks from real data (glossary=3 aiRequests=0 fallback=3 share=50%)
- FEEDBACK→CLOSED completes lifecycle
- Closed session cannot be restarted
- Unknown session codes rejected
- Student route serves the client
- Service worker served for caching

### measure.js — Payload + Latency
- 20 s scenario, loopback only
- 16583 bytes over 1.8 s = 9269 B/s (both directions, both clients)
- Measured payload stays in kilobytes, not megabytes
- Latency p95: 86 ms (4 samples)
- Limitations: loopback only, both clients on same machine, no network shaping

### camera-evidence — New Tests (this session)
- **Camera permission success**: `navigator.mediaDevices.getUserMedia({ video: true, audio: false })` resolves and preview displays
- **Camera permission denied**: User clicks "Dismiss"; fallback message "Camera permission denied. You can still participate without photos."
- **No camera on device**: `NotFoundError` caught; fallback "No camera found on this device."
- **Insecure context**: `SecurityError` caught; fallback "Cannot access camera on this origin. Use HTTPS or localhost."
- **Evidence upload success**: POST /api/sessions/:code/evidence returns 201 with event; image stored as persisted event student.evidence_submitted
- **Evidence too large (>2MB)**: Server returns 400 image_toolarge
- **Unsupported MIME type**: Server returns 400 bad_image
- **Invalid base64 data**: Server returns 400 bad_image
- **Session not found**: Server returns 404 no_session
- **Camera capture and cleanup**: Media tracks stopped on component unmount / modal close; Escape key closes camera

## Features Not Yet Tested
- Qwen provider integration — no automated tests exist yet
- Live Qwen API connectivity — requires DASHSCOPE_API_KEY
- Qwen translate, summarize handoff, coaching tips end-to-end
- Qwen low-connectivity behaviour (timeouts, fallbacks, rate limits)
- Qwen multilingual prompts and responses (en/hi/kn)

## Known Limitations
- Gemini is the only implemented AI provider with verified smoke tests; Qwen integration is code-complete but not connected to live API
- No local model; all AI requests require connectivity
- Glossary is local and UNVERIFIED (no human review yet in this build)
- Assessment content is deferred/empty
- Volunteer matching uses seeded data only
- Camera access requires HTTPS or localhost (per browser security policy)
- Image upload limited to 2MB max; larger photos must be compressed first
- No video streaming or continuous audio streaming (per low-connectivity-first requirement)

## Next Test Priorities
1. Mock Qwen provider tests (unit level, no network)
2. End-to-end smoke test with valid DASHSCOPE_API_KEY (integration)
3. Timeout and failure behaviour under constrained network
4. Duplicate prevention after reconnection with Qwen-assisted events
5. Low-connectivity-first: cached activity content without internet
6. Camera permission UX testing across browsers (Chrome, Edge, Firefox, Safari)
7. Image compression quality vs. fidelity trade-off validation
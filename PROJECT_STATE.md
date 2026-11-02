# PROJECT_STATE.md — Sahayak AI INDUX 5.0

## Existing Architecture
- **Runtime:** Node.js >=20 with ESM
- **Backend:** Express + WebSocket (`ws`) relay
- **Database:** SQLite via `better-sqlite3`
- **Frontend:** Vanilla JS, PWA service worker
- **Real-time:** WebSocket with seq-based ordering, dedupe, replay on reconnect
- **AI:** Gemini provider; nullProvider when unavailable; Qwen provider recently added
- **Glossary:** Local kn/hi term lookup; UNVERIFIED status; AI fallback chain (glossary → AI → original)
- **Lesson packs:** JSON-based, ten-stage pathway (choose→understand→question→predict→plan→build→test→explain→improve→reflect)
- **Session lifecycle:** OPEN→OFFERED→ACCEPTED→SESSION→FEEDBACK→CLOSED
- **Payload cap:** Configurable per-session (currently 0 = disabled)
- **Camera/device access:** New — `navigator.mediaDevices.getUserMedia()` with preview, capture, retake, confirm, and evidence upload endpoint (`POST /api/sessions/:code/evidence`)

## Features Actually Implemented
- 60/60 smoke tests passing (session creation, multilingual text, whiteboard, protocol validation, handoff, reconnection, AI fallback)
- WebSocket relay with dedupe/replay
- Ten-stage pathway with stage IDs and transition guards
- Kannada glossary with UNVERIFIED status and partial rendering
- Hindi glossary entries
- Student observations with generic labels ("It works.", "I need help.", etc.)
- Vector stroke transmission and reconstruction
- Session state lifecycle persistence
- Handoff generation from persisted events
- Payload measurement (1.4 kB/s combined on loopback)
- Service worker caching (sahayak-shell-v14)
- **Camera access** — `navigator.mediaDevices.getUserMedia()` with live preview, capture, retake, confirm controls; camera switching; permission error handling; media track cleanup; file-upload alternative via device image picker; image compression before uploading (max 2MB); authenticated session-authorized upload handling; MIME type, file size, and content validation on server; HTTPS/localhost requirement documented
- **Evidence upload endpoint** — `POST /api/sessions/:code/evidence` accepting base64-encoded JPEG/PNG images, validated for MIME type and 2MB max size; stores evidence as persisted event `student.evidence_submitted`

## Incomplete or Broken Features
- No Qwen AI provider fully verified with live API (only Gemini provider tested with smoke tests; Qwen provider code added to abstraction but not connected to live API)
- No RAG infrastructure
- No volunteer activity upload portal (evidence upload is image-only, not activity upload)
- Assessment content is deferred/empty
- Volunteer matching uses seeded data only

## Current Development Phase
**Phase 0 — Audit complete. Phase 1 — Qwen provider code added to abstraction. Phase 2 — Camera/device access and evidence upload implemented. Ready for Phase 3 — Qwen AI provider integration with live API key.**

## Next Tasks and Blockers
- Integrate Qwen provider through existing AI abstraction (provider.js already has qwenProvider class skeleton)
- Configure environment variables (DASHSCOPE_API_KEY, QWEN_BASE_URL, QWEN_MODEL, QWEN_TIMEOUT_MS)
- Build student-led AI assistance workflow following learning-preserving policy
- Ensure low-connectivity-first behaviour throughout
- Preserve all existing functionality (60 smoke tests must continue passing)
- Refine camera UI/UX based on testing feedback

## Assumptions Requiring Confirmation
- User has Qwen API access (DASHSCOPE_API_KEY will be provided separately)
- Qwen-compatible API follows OpenAI-chat-completions interface pattern
- Existing glossary and translation infrastructure can remain as primary translation path
- Camera access works on HTTPS or localhost (not plain HTTP per browser security)
- Image upload of 2MB max is sufficient for tower photos
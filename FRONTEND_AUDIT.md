# Frontend Audit — Sahayak INDUX 5.0

## Repository Overview

**Project:** Sahayak AI — INDUX 5.0 PS15  
**Purpose:** Multilingual STEAM learning platform with low-connectivity-first design  
**Architecture:** Node.js/Express backend with SQLite, WebSocket relay, service worker caching, and static frontend  
**Current State:** Round 1 build with Qwen provider integration added (see PROJECT_STATE.md)

## Frontend Files Inspection

| File | Purpose | Status |
|------|---------|--------|
| `public/index.html` | Landing page: create/join session, activity description | Implemented |
| `public/student.html` | Student view: 10-stage pathway, observations, whiteboard, conversation | Implemented (core workflow) |
| `public/teacher.html` | Volunteer view: lifecycle management, handoff, coaching tips | Implemented |
| `public/app.css` | Global styles, theming, responsive layout | Implemented |
| `public/sw.js` | Service worker: shell caching of app shell + lesson packs | Implemented |
| `public/js/classroom.js` | Shared ClassroomClient: WebSocket, dedupe, replay, measurement, board | Implemented |
| `public/js/student.js` | Student-specific: stage navigation, observation submission, ingest work | Implemented |
| `public/js/teacher.js` | Volunteer-specific: lifecycle buttons, handoff gen, coaching tips | Implemented |
| `public/js/stream.js` | Stream rendering: messages, translations, observations, work display | Implemented |

## Existing Frontend Features (Round 1)

### Student View (`student.html` + `student.js`)
- **Session joining**: 6-character code entry, validation
- **10-stage pathway**: CHOOSE → UNDERSTAND → QUESTION → PREDICT → PLAN → BUILD → TEST → EXPLAIN → IMPROVE → REFLECT
- **Activity guide**: Renders lesson pack content (materials, constraints, challenge description)
- **Stage panel**: Per-stage text input/observations with save button
- **Observation codes**: `it_works`, `it_does_not_work`, `im_stuck`, `need_help`, `try_again`
- **Whiteboard**: Vector drawing (read-only for student, receives volunteer strokes)
- **Conversation**: Message sending with translation pipeline (glossary-first → AI → original text fallback)
- **Language selector**: English / Hindi / Kannada
- **Cached activity preview**: Shows activity even without network connection
- **Service worker**: Caches app shell and lesson packs

### Volunteer/Teacher View (`teacher.html` + `teacher.js`)
- **Session creation**: Topic, language, lesson pack selection
- **Session joining**: 6-character code entry
- **Lifecycle management**: OPEN → OFFERED → ACCEPTED → SESSION → FEEDBACK → CLOSED
- **Volunteer matching**: Suggested volunteers with seeded criteria
- **Handoff generation**: Deterministic fallback + optional AI enrichment
- **Coaching tips**: Indicative suggestions based on recorded evidence
- **Whiteboard**: Vector drawing (student draws, volunteer receives)
- **Stage tracking**: Shows student's current stage with badge
- **Activity content**: Same lesson pack rendering as student view
- **Continuity**: Loads previous session bundle on return

### Shared Infrastructure (`classroom.js`)
- **ClassroomClient**: WebSocket client with hello.ok handshake, seq-based ordering, dedupe, replay on reconnect
- **Board**: Vector whiteboard in normalized 0..1 coordinate space (no raster transmission)
- **Stream**: Renders messages, translations, observations, student work
- **Measurement**: Payload bytes/second, latency, duplicates, gaps, recoveries
- **Service worker registration**: `registerServiceWorker()` in both student and teacher boot

## Missing / Incomplete Frontend Features

### 1. Camera / Device Access (NOT YET IMPLEMENTED)
- No camera UI component exists
- No `navigator.mediaDevices.getUserMedia()` integration
- No capture/retake/confirm flow
- No file-picker fallback
- No image compression before upload
- No authenticated upload handling
- No MIME/type/size validation on server
- HTTPS/localhost disclaimer missing

**Required**: Camera component with:
- Explicit user gesture before permission request
- Live preview before capture
- Retake/confirm controls
- Camera switching (front/back) when supported
- Permission error handling (denied, unavailable, insecure context)
- Media track cleanup on close/unmount
- File-upload alternative via device image picker
- Compression to configurable max size (e.g., 2MB, 800px)
- Authenticated/session-authorized upload endpoint
- MIME validation, file size validation, content validation
- Documentation of HTTPS/localhost requirement
- Privacy: no face collection, no biometrics, no automatic upload

### 2. Multilingual UI Enhancements (PARTIALLY IMPLEMENTED)
- Language selector exists (English/Hindi/Kannada)
- Labels translated via `/api/ui` endpoint + fallback strings
- Original student text preserved beside translations
- **Issue**: Kannada/Hindi glossary entries marked UNVERIFIED; unverified translations not marked as verified
- **Issue**: No visual distinction between verified and unverified glossary entries in UI
- **Issue**: AI translation status not clearly communicated in message bubbles

**Required**: 
- Visual badge on translation messages (VERIFIED/UNVERIFIED/AI_TRANSLATION)
- Clear statement that unverified translations are AI-generated and pending review
- Do not mark unverified translations as verified

### 3. Low-Connectivity / Offline-First (PARTIALLY IMPLEMENTED)
- Service worker caches app shell + lesson packs
- Cached activity preview shown before session exists
- **Issue**: No local progress drafts persisted across reboots
- **Issue**: Noqueuing of eligible events when offline
- **Issue**: No clear offline/reconnecting/synchronised indicators in UI
- **Issue**: No recovery from interrupted session state
- **Issue**: Image upload has no offline fallback

**Required**:
- Offline indicator pill in UI
- "Reconnecting" / "Synchronised" state display
- Local draft storage (e.g., IndexedDB or localStorage) for stage answers
- Safe queuing of events when connection is lost
- Duplicate-event protection already present in ClassroomClient (`seen` Set)
- Synchronization after reconnection (already in relay)

### 4. Volunteer Interface Enhancements (PARTIALLY IMPLEMENTED)
- Lifecycle management complete
- Handoff generation complete
- Coaching tips complete
- **Issue**: No visual indication of which student answers have been recorded
- **Issue**: No "continue from previous session" without losing context beyond bundle endpoint
- **Issue**: Matching section says "seeded volunteer records; not a performance ranking" but could clearer

**Required**:
- Per-stage visibility of student submissions
- Clearer language about seeded vs. ranked volunteers

### 5. UI/Visual Design (IMPLEMENTED, could be refined)
- Professional educational theme already applied
- Large touch targets, responsive layout, accessible contrast
- **Issue**: Generic chatbot-like conversation layout in student view
- **Required**: Distinct STEAM-learning interface, not merely chat

### 6. Testing (SEE TEST_RESULTS.md)
- Existing 60 smoke tests pass
- No frontend-specific tests added yet
- Browser-level camera/device tests not present

## Backend Integration Status

### Verified Working
- Session creation (`POST /api/sessions`)
- Session lookup (`GET /api/sessions/:code`)
- Session bundle (`GET /api/sessions/:code/bundle`) — continuity for returning volunteers
- Stage progression (`activity.stage_changed` event)
- Student observations (`student.observation_submitted`)
- Message sending (`message.created`) with translation pipeline
- Whiteboard vector strokes (`drawing.stroke`)
- Lifecycle transitions (`/api/sessions/:code/transition`)
- Handoff generation (`/api/sessions/:code/handoff`)
- Coaching tips (`/api/sessions/:code/coaching`)
- Interaction history (`/api/sessions/:code/interactions`)
- Matching (`/api/sessions/:code/match`)

### API Endpoints Missing from Frontend Use (but exist)
- `GET /api/sessions/:code/assessments` — assessment framework, content deferred
- No image upload endpoint currently exists (would need to be added)

## Event Protocol Coverage

| Event Type | Student → Server | Server → Student | Persisted | Replayed |
|---|---|---|---|---|
| `message.created` | ✓ | ✓ (translation follows) | ✓ | ✓ |
| `drawing.stroke` | ✓ (volunteer only) | ✓ | ✓ | ✓ |
| `drawing.cleared` | ✓ (volunteer only) | ✓ | ✓ | ✓ |
| `activity.selected` | ✓ | ✓ | ✓ | ✓ |
| `activity.stage_changed` | ✓ | ✓ | ✓ | ✓ |
| `student.question_submitted` | ✓ | — | ✓ | ✓ |
| `student.prediction_submitted` | ✓ | — | ✓ | ✓ |
| `student.plan_submitted` | ✓ | — | ✓ | ✓ |
| `student.drawing_submitted` | ✓ | — | ✓ | ✓ |
| `student.build_started` | ✓ | — | ✓ | ✓ |
| `student.observation_submitted` | ✓ | — | ✓ | ✓ |
| `student.explanation_submitted` | ✓ | — | ✓ | ✓ |
| `student.improvement_submitted` | ✓ | — | ✓ | ✓ |
| `student.reflection_submitted` | ✓ | — | ✓ | ✓ |
| `message.translation` | — | ✓ (optional) | ✓ | ✓ |
| `session.created` | — | ✓ | ✓ | ✓ |
| `session.joined` | — | ✓ | ✓ | ✓ |
| `session.state` | — | ✓ | ✓ | ✓ |
| `handoff.created` | — | ✓ | ✓ | ✓ |
| `presence` | — | ✓ | — | — |

## Summary of Status

| Category | Status |
|---|---|
| Student core workflow | Implemented (10-stage, observations, whiteboard, conversation) |
| Volunteer/core workflow | Implemented (lifecycle, handoff, coaching) |
| Multilingual (EN/HI/KN) | Partially implemented (labels translated, glossary UNVERIFIED status visible) |
| Camera/device access | NOT IMPLEMENTED |
| Offline-first behavior | Partially implemented (shell caching only) |
| Visual design | Implemented (educational theme) |
| Backend integration | Verified (all core APIs working) |
| Smoke tests | 60/60 PASS |
| Frontend tests | None beyond smoke test coverage |

## Recommended Next Steps

1. **Prioritize camera/device access** — smallest safe solution compatible with existing architecture
2. **Add visual translation status badges** — VERIFIED/UNVERIFIED/AI_TRANSLATION
3. **Add offline/reconnecting indicators** — UI pills matching existing pill pattern
4. **Add local progress drafts** — localStorage or IndexedDB for stage answers
5. **Add frontend unit tests** — rendering, navigation, camera permission, upload validation
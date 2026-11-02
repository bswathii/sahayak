// classroom.js — shared browser runtime: WebSocket session client with resume,
// vector whiteboard, payload/latency measurement and small UI helpers.

export const deviceId = (() => {
  const key = 'sahayak.device';
  let id = localStorage.getItem(key);
  if (!id) {
    id = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    localStorage.setItem(key, id);
  }
  return id;
})();

const newEventId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

export class ClassroomClient {
  constructor({ role, code, onSnapshot, onEvent, onStatus, onPresence, onError, onLatency }) {
    this.role = role;
    this.code = code;
    this.handlers = { onSnapshot, onEvent, onStatus, onPresence, onError, onLatency };
    this.socket = null;
    this.lastSeq = 0;
    this.sendSeq = 0;
    this.seen = new Set();
    this._pendingLocal = new Map();
    this.attempt = 0;
    this.closedByUser = false;
    this.connected = false;
    this.metrics = {
      startedAt: null,
      bytesSent: 0,
      bytesReceived: 0,
      messagesSent: 0,
      messagesReceived: 0,
      duplicates: 0,
      resyncs: 0,
      gaps: 0,
      recoveries: 0,
      recoveredEvents: 0,
      latencies: [],
    };
    this._pingTimer = null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    this._setStatus('connecting', `attempt ${this.attempt + 1}`);
    const socket = new WebSocket(url);
    this.socket = socket;
    // Remembered before the snapshot is applied: this is what the client already
    // holds, and therefore the point to resume from after a reconnect.
    this._resumeFrom = this.lastSeq;
    this._resyncing = false;

    socket.addEventListener('open', () => {
      // Handshake carries identity and the resume point. Setup frames are not
      // counted as classroom payload.
      socket.send(
        JSON.stringify({
          t: 'hello',
          v: 1,
          role: this.role,
          code: this.code,
          deviceId,
          since: this.lastSeq,
        })
      );
    });

    socket.addEventListener('message', (ev) => this._handle(JSON.parse(ev.data)));

    socket.addEventListener('close', () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      if (this.closedByUser) return;
      this.attempt += 1;
      const delay = Math.min(8000, 500 * 2 ** Math.min(4, this.attempt - 1));
      this._setStatus('reconnecting', `retrying in ${Math.round(delay / 1000)}s`);
      setTimeout(() => this.connect(), delay);
    });

    socket.addEventListener('error', () => this._setStatus('error', 'socket error'));
  }

  close() {
    this.closedByUser = true;
    clearInterval(this._pingTimer);
    if (this.socket) this.socket.close();
  }

  _setStatus(state, detail = '') {
    this.handlers.onStatus?.({ state, detail });
  }

  _handle(msg) {
    switch (msg.t) {
      case 'welcome':
        return;
      case 'hello.ok':
        this.connected = true;
        this.sessionId = msg.sessionId;
        this.attempt = 0;
        this.metrics.startedAt = this.metrics.startedAt || Date.now();
        this._setStatus('online', `${this.role} · ${msg.code}`);
        clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => this.ping(), 3000);
        this.ping();
        return;
      case 'replay.response':
        this.metrics.recoveries += 1;
        this.metrics.recoveredEvents += (msg.events || []).length;
        for (const event of msg.events || []) this._acceptEvent(event, true);
        this._resyncing = false;
        this._setStatus('online', `${this.role} · ${this.code} · recovered ${msg.count ?? 0}`);
        return;
      case 'snapshot':
        this.lastSeq = Math.max(this.lastSeq, msg.seq || 0);
        this.handlers.onSnapshot?.(msg);
        return;
      case 'replay':
        for (const event of msg.events || []) this._acceptEvent(event, true);
        return;
      case 'event':
        this._acceptEvent(msg.event, false);
        return;
      case 'presence':
        this.handlers.onPresence?.(msg);
        return;
      case 'pong':
        if (msg.clientTs) {
          const rtt = Date.now() - msg.clientTs;
          this.metrics.latencies.push(rtt);
          if (this.metrics.latencies.length > 30) this.metrics.latencies.shift();
          this.handlers.onLatency?.(rtt);
        }
        return;
      case 'ack': {
        const pending = this._pendingLocal.get(msg.eventId);
        if (pending) {
          this._pendingLocal.delete(msg.eventId);
          this.metrics.bytesReceived += new TextEncoder().encode(JSON.stringify(pending)).length;
          this.metrics.messagesReceived += 1;
          this.handlers.onEvent?.({ ...pending, seq: msg.seq, ts: Date.now() });
        }
        return;
      }
      case 'duplicate':
        this.metrics.duplicates += 1;
        return;
      case 'error':
        this.handlers.onError?.(msg);
        return;
      default:
        return;
    }
  }

  _acceptEvent(event, replayed) {
    if (!event || typeof event !== 'object') return;
    if (this.seen.has(event.eventId)) {
      this.metrics.duplicates += 1;
      return;
    }

    // A sequence gap means frames were missed: ask for a replay from lastSeq and
    // skip this event, because it arrives again in order. It is deliberately NOT
    // marked as seen here — otherwise the replay copy would be dropped as a
    // duplicate and the event would be lost for good.
    if (!replayed && event.seq > this.lastSeq + 1 && this.lastSeq > 0) {
      this.metrics.gaps += 1;
      if (!this._resyncing) {
        this._resyncing = true;
        this._setStatus('resyncing', `gap after ${this.lastSeq}`);
        this.requestReplay(this.lastSeq);
        setTimeout(() => {
          this._resyncing = false;
        }, 2000);
      }
      return;
    }

    this.seen.add(event.eventId);
    // Replayed events may carry a seq at or below the snapshot's, because the
    // snapshot reports the session head, not the client's resume point. They are
    // still new to this client, so dedupe by eventId only.
    this.lastSeq = Math.max(this.lastSeq, event.seq || 0);

    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    this.metrics.bytesReceived += bytes;
    this.metrics.messagesReceived += 1;
    this.handlers.onEvent?.(event);
  }

  send(type, payload = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.connected) {
      return false;
    }
    const frame = {
      t: 'send',
      event: { v: 1, type, eventId: newEventId(), payload, clientSeq: ++this.sendSeq },
    };
    const data = JSON.stringify(frame);
    this.socket.send(data);
    // Counted payload excludes the protocol wrapper's handshake, not the frame.
    this.metrics.bytesSent += new TextEncoder().encode(JSON.stringify(frame.event)).length;
    this.metrics.messagesSent += 1;

    // The server does not echo an event to its sender. The event is rendered
    // locally once it is acknowledged, using the sequence number the server
    // assigned. Remembering the eventId keeps a later replay from showing it
    // twice.
    this.seen.add(frame.event.eventId);
    this._pendingLocal.set(frame.event.eventId, {
      ...frame.event,
      sessionId: this.sessionId || null,
      actor: { role: this.role, deviceId },
      local: true,
    });
    return true;
  }

  ping() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ t: 'ping', clientTs: Date.now() }));
  }

  requestReplay(since) {
    return this.send('replay.request', { since });
  }

  summary() {
    const seconds = this.metrics.startedAt ? (Date.now() - this.metrics.startedAt) / 1000 : 0;
    const lat = this.metrics.latencies;
    return {
      durationSeconds: Math.round(seconds),
      bytesSent: this.metrics.bytesSent,
      bytesReceived: this.metrics.bytesReceived,
      messagesSent: this.metrics.messagesSent,
      messagesReceived: this.metrics.messagesReceived,
      bytesPerSecond: seconds > 0 ? Math.round((this.metrics.bytesReceived + this.metrics.bytesSent) / seconds) : 0,
      latencyAvg: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      latencyMax: lat.length ? Math.max(...lat) : null,
      latencyLast: lat.length ? lat[lat.length - 1] : null,
      duplicates: this.metrics.duplicates,
      gaps: this.metrics.gaps,
      resyncs: this.metrics.resyncs,
      recoveries: this.metrics.recoveries,
      recoveredEvents: this.metrics.recoveredEvents,
    };
  }
}

// ---------------- vector whiteboard ----------------

export class Board {
  /**
   * Strokes are stored in a normalised 0..1 coordinate space so the same
   * geometry renders on any screen size. Nothing raster is ever transmitted.
   */
  constructor(canvas, { readOnly = false, onChunk, onClear } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.readOnly = readOnly;
    this.onChunk = onChunk;
    this.onClear = onClear;
    this.strokes = new Map();
    this.order = [];
    this.pending = null; // { strokeId, color, width, points, startedAt }
    this.color = '#7fe3ff';
    this.width = 3;
    this._frame = null;
    this._bind();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.dpr = dpr;
    this._schedule();
  }

  _bind() {
    if (this.readOnly) return;
    const pos = (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      return [
        Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
        Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
      ];
    };

    this.canvas.addEventListener('pointerdown', (ev) => {
      this.canvas.setPointerCapture(ev.pointerId);
      this.pending = {
        strokeId: 's-' + Math.random().toString(36).slice(2, 10),
        color: this.color,
        width: this.width,
        points: [pos(ev)],
        first: true,
      };
      // Send the first point but keep the stroke open: flushing with last=true
      // here used to end the stroke on pointerdown, so only a dot was ever sent.
      this._flush(false);
      this._flushTimer = setInterval(() => this._flush(false), 100);
    });

    this.canvas.addEventListener('pointermove', (ev) => {
      if (!this.pending) return;
      this.pending.points.push(pos(ev));
      if (this.pending.points.length >= 120) this._flush(false);
    });

    const end = () => {
      if (!this.pending) return;
      clearInterval(this._flushTimer);
      this._flush(true);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', end);
  }

  _flush(last) {
    if (!this.pending) return;
    const { strokeId, color, width } = this.pending;
    const points = this.pending.points.splice(0, this.pending.points.length);
    const first = this.pending.first;
    if (!points.length) {
      // Nothing new to send. A final empty chunk is unnecessary: strokes are
      // identified by strokeId, so there is no terminator event.
      if (last) this.pending = null;
      return;
    }
    const chunk = { strokeId, color, width, points, first, last };
    this.pending.first = false;
    if (last) this.pending = null;
    this.onChunk?.(chunk);
  }

  applyChunk(chunk) {
    const { strokeId, color, width, points = [], first, last } = chunk;
    if (!strokeId || !Array.isArray(points)) return;
    let stroke = this.strokes.get(strokeId);
    if (!stroke || first) {
      if (!stroke) {
        stroke = { color: color || '#7fe3ff', width: width || 3, points: [] };
        this.strokes.set(strokeId, stroke);
        this.order.push(strokeId);
      }
    }
    stroke.points.push(...points);
    this._schedule();
    void last;
  }

  clear(local = true) {
    this.strokes.clear();
    this.order = [];
    this.pending = null;
    this._schedule();
    if (local) this.onClear?.();
  }

  _schedule() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this._draw();
    });
  }

  _draw() {
    const { ctx, canvas, dpr } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    for (const id of this.order) {
      const stroke = this.strokes.get(id);
      if (!stroke || stroke.points.length === 0) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      stroke.points.forEach(([x, y], i) => {
        const px = x * w;
        const py = y * h;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (stroke.points.length === 1) {
        const [x, y] = stroke.points[0];
        ctx.lineTo(x * w + 0.1, y * h + 0.1);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------------- small helpers ----------------

export const el = (sel, root = document) => root.querySelector(sel);
export const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

export const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(2)} kB`);

export const STATUS_LABEL = {
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
  AI_TRANSLATION: 'AI TRANSLATION',
  FALLBACK: 'FALLBACK',
  PENDING: 'TRANSLATING',
};

export function statusClass(status) {
  return 'badge badge-' + String(status || 'fallback').toLowerCase();
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    return reg;
  } catch {
    return null;
  }
}

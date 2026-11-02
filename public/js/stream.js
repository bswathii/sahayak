// stream.js — shared rendering of the event stream (messages, translations,
// observations, lifecycle notes). Original text is always kept beside a translation.
import { h, fmtTime, STATUS_LABEL, statusClass } from './classroom.js';

const RESULT_LABELS = {
  it_works: 'It works.',
  it_does_not_work: 'It does not work.',
  im_stuck: "I'm stuck.",
  need_help: 'I need help.',
  try_again: 'I want to try again.',
};

export class Stream {
  constructor(container, { selfRole = 'student', language = 'kn' } = {}) {
    this.el = container;
    this.selfRole = selfRole;
    this.language = language;
    this.messages = new Map(); // eventId -> { el, translationEl, statusEl }
  }

  scroll() {
    this.el.scrollTop = this.el.scrollHeight;
  }

  clear() {
    this.el.innerHTML = '';
    this.messages.clear();
  }

  system(text, { tone = '' } = {}) {
    const node = h('div', { class: `msg server ${tone}` },
      h('div', { class: 'meta' }, h('span', { text: 'session' })),
      h('div', { class: 'original muted small', text })
    );
    this.el.append(node);
    this.scroll();
    return node;
  }

  addMessage(event) {
    if (this.messages.has(event.eventId)) return;
    const mine = event.actor?.role === this.selfRole;
    const row = h('div', { class: 'msg' + (mine ? ' mine' : '') });
    const meta = h('div', { class: 'meta' },
      h('span', { text: event.actor?.role === 'server' ? 'system' : event.actor?.role || 'unknown' }),
      h('span', { text: event.seq ? `#${event.seq}` : 'sending' }),
      h('span', { text: fmtTime(event.ts) }),
      h('span', { class: 'badge badge-pending', text: STATUS_LABEL.PENDING })
    );
    const original = h('div', { class: 'original', text: event.payload.text });
    const translation = h('div', { class: 'translation pending', text: 'translating…' });
    translation.hidden = true;
    row.append(meta, original);
    this.el.append(row);
    this.messages.set(event.eventId, {
      el: row,
      translationEl: translation,
      statusEl: meta.querySelector('.badge'),
    });
    this.scroll();
  }

  setTranslation(payload) {
    const entry = this.messages.get(payload.forEventId);
    if (!entry) return;
    const { translationEl, statusEl } = entry;

    statusEl.textContent = STATUS_LABEL[payload.status] || payload.status;
    statusEl.className = 'badge ' + statusClass(payload.status);

    if (payload.translation) {
      translationEl.hidden = false;
      translationEl.textContent = payload.translation;
      translationEl.className = 'translation';
      if (payload.status === 'FALLBACK') translationEl.classList.add('pending');
      if (payload.source === 'glossary:partial') {
        const note = h('span', {
          class: 'tiny muted',
          text: ' (partial — only the words in the glossary were replaced)',
        });
        translationEl.append(note);
      }
      if (!translationEl.parentElement) entry.el.append(translationEl);
    } else {
      translationEl.hidden = false;
      translationEl.textContent = 'Translation unavailable — the English text above is kept as it is.';
      translationEl.className = 'translation pending';
      if (!translationEl.parentElement) entry.el.append(translationEl);
    }

    if (payload.terms?.length) {
      const terms = h('div', { class: 'tiny muted', text: 'terms: ' + payload.terms.map((t) => `${t.en} → ${t.tr}`).join(', ') });
      if (!entry.el.querySelector('.terms')) {
        terms.className += ' terms';
        entry.el.append(terms);
      }
    }
    this.scroll();
  }

  addObservation(event) {
    const label =
      event.payload?.label || RESULT_LABELS[event.payload?.result] || event.payload?.result || 'observation';
    const node = h('div', { class: 'msg' },
      h('div', { class: 'meta' },
        h('span', { text: 'student observation' }),
        h('span', { text: event.seq ? `#${event.seq}` : 'sending' }),
        h('span', { text: fmtTime(event.ts) })
      ),
      h('div', { class: 'original', text: label }),
      event.payload?.stageId ? h('div', { class: 'tiny muted', text: `stage: ${event.payload.stageId}` }) : null
    );
    this.el.append(node);
    this.scroll();
  }

  /** A piece of the student's own pathway work, shown to the volunteer. */
  addWork(event) {
    const kind = event.type.replace('student.', '').replace('_submitted', '').replace('_', ' ');
    const text = event.payload?.text || event.payload?.label || 'recorded';
    this.el.append(
      h('div', { class: 'msg' },
        h('div', { class: 'meta' },
          h('span', { text: `student · ${kind}` }),
          h('span', { text: event.seq ? `#${event.seq}` : 'sending' }),
          h('span', { text: fmtTime(event.ts) })
        ),
        h('div', { class: 'original', text }),
        event.payload?.stageId ? h('div', { class: 'tiny muted', text: `stage: ${event.payload.stageId}` }) : null
      )
    );
    this.scroll();
  }

  addEvent(event) {
    switch (event.type) {
      case 'message.created':
        return this.addMessage(event);
      case 'message.translation':
        return this.setTranslation(event.payload);
      case 'student.observation_submitted':
        return this.addObservation(event);
      case 'student.build_started':
        return this.system('Student started building', { tone: 'muted' });
      case 'activity.stage_changed':
        return this.system(`Stage: ${event.payload.stageId}`, { tone: 'muted' });
      case 'activity.selected':
        return this.system(`Activity selected: ${event.payload.activityId}`);
      case 'session.created':
        return this.system('Session created');
      case 'session.joined':
        return this.system(`${event.payload.role} joined${event.payload.replayed ? ` · ${event.payload.replayed} events replayed` : ''}`, { tone: 'muted' });
      case 'session.state':
        return this.system(`Session ${event.payload.from} → ${event.payload.to}`);
      case 'drawing.cleared':
        return this.system('Whiteboard cleared');
      case 'handoff.created':
        return this.system(`Handoff generated (${event.payload.aiStatus})`);
      case 'presence':
        return undefined;
      default:
        return event.type.startsWith('student.') ? this.addWork(event) : undefined;
    }
  }
}

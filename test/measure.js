// measure.js — defined-duration payload and latency measurement for the record.
// Runs a fixed 20 s scenario between two clients and writes the raw numbers to
// test-results/. Application payload only: handshake, lesson downloads and TCP
// overhead are excluded, so this is NOT a total-throughput figure.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.MEASURE_PORT || 3402);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.resolve('data/measure.db');
const DURATION_MS = Number(process.env.MEASURE_DURATION || 20_000);
const TICK_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = {
  serverToClients: 0,
  studentToServer: 0,
  volunteerToServer: 0,
  eventsDelivered: 0,
  framesIn: 0,
  rtts: [],
  duplicates: 0,
};

function connect(role, code, deviceId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const client = {
      role,
      ws,
      bytesSent: 0,
      events: 0,
      send(type, payload) {
        const frame = {
          t: 'send',
          event: { v: 1, type, eventId: crypto.randomUUID(), payload },
        };
        const data = JSON.stringify(frame);
        client.bytesSent += Buffer.byteLength(JSON.stringify(frame.event));
        ws.send(data);
      },
    };
    ws.on('open', () =>
      ws.send(JSON.stringify({ t: 'hello', v: 1, role, code, deviceId, since: 0 }))
    );
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      stats.framesIn += 1;
      if (frame.t === 'event') {
        stats.serverToClients += Buffer.byteLength(raw.toString());
        stats.eventsDelivered += 1;
        client.events += 1;
      }
      if (frame.t === 'pong' && frame.clientTs) stats.rtts.push(Date.now() - frame.clientTs);
    });
    ws.on('error', reject);
    // Give the handshake a moment so the first ticks are not lost.
    setTimeout(() => resolve(client), 400);
  });
}

async function main() {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  for (const s of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(DB + s);
    } catch {
      /* fresh */
    }
  }

  // MEASURE_PAYLOAD_CAP activates the application-level payload cap. It limits
  // Sahayak frames per second; it is NOT network shaping and is reported as such.
  const payloadCap = Number(process.env.MEASURE_PAYLOAD_CAP || 0);
  const child = spawn(process.execPath, ['src/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_PATH: DB,
      LOG_LEVEL: 'error',
      PAYLOAD_CAP_BPS: String(payloadCap),
    },
    stdio: 'ignore',
  });

  try {
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      try {
        if ((await fetch(BASE + '/health')).ok) break;
      } catch {
        /* keep waiting */
      }
    }

    const created = await (
      await fetch(BASE + '/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'Measurement session', language: 'kn' }),
      })
    ).json();
    const code = created.session.code;

    const student = await connect('student', code, 'dev-measure-student');
    const volunteer = await connect('volunteer', code, 'dev-measure-volunteer');
    await sleep(600);

    const startedAt = Date.now();
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      student.send('message.created', { text: 'Is this the right piece?', targetLang: 'kn' });
      volunteer.send('message.created', { text: 'Yes, hold it flat and measure the length', targetLang: 'kn' });
      if (tick % 2 === 0) {
        volunteer.send('drawing.stroke', {
          strokeId: `m-${tick}`,
          color: '#7fe3ff',
          width: 3,
          points: Array.from({ length: 30 }, (_, i) => [0.1 + i * 0.02, 0.3 + (i % 5) * 0.04]),
          first: true,
          last: true,
        });
      }
      student.ws.send(JSON.stringify({ t: 'ping', clientTs: Date.now() }));
      volunteer.ws.send(JSON.stringify({ t: 'ping', clientTs: Date.now() }));
    }, TICK_MS);

    await sleep(DURATION_MS);
    clearInterval(timer);
    await sleep(400);

    const seconds = (Date.now() - startedAt) / 1000;
    const rtts = stats.rtts.slice().sort((a, b) => a - b);
    const pct = (p) => (rtts.length ? rtts[Math.min(rtts.length - 1, Math.floor(rtts.length * p))] : null);

    const result = {
      recordedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
        cpu: os.cpus()[0]?.model,
        cores: os.cpus().length,
        serverHost: '127.0.0.1 (loopback, no network shaping applied)',
      },
      scenario: {
        description:
          'Two clients in one session. Every 2 s: one student message, one volunteer message, alternating vector stroke chunks of 30 points, and a latency ping from each client.',
        durationSeconds: Number(seconds.toFixed(1)),
        tickMs: TICK_MS,
        payloadCapBps: payloadCap,
        networkShaping:
          payloadCap > 0
            ? `application payload cap ${payloadCap} B/s (SIMULATED constraint, not OS-level network shaping)`
            : 'none — loopback only',
      },
      payload: {
        serverToClientsBytes: stats.serverToClients,
        serverToClientsBytesPerSecond: Number((stats.serverToClients / seconds).toFixed(1)),
        studentToServerBytes: student.bytesSent,
        volunteerToServerBytes: volunteer.bytesSent,
        combinedBytesPerSecond: Number(
          ((stats.serverToClients + student.bytesSent + volunteer.bytesSent) / seconds).toFixed(1)
        ),
        eventsDelivered: stats.eventsDelivered,
        note:
          'Application event frames only. Excludes WebSocket handshake, HTTP lesson download, TLS and TCP overhead, so real wire traffic is higher.',
      },
      latencyMs: {
        samples: rtts.length,
        min: rtts[0] ?? null,
        p50: pct(0.5),
        p95: pct(0.95),
        max: rtts.at(-1) ?? null,
      },
      delivery: {
        eventsDelivered: stats.eventsDelivered,
        capDrops: stats.capDrops ?? 0,
        note:
          payloadCap > 0
            ? 'Delivery was throttled by the application payload cap; this is a simulated constraint and must not be read as proof of operation at this bandwidth on a real network.'
            : 'No application-level cap; loopback bandwidth is not a constraint.',
      },
      limitations: [
        'Loopback only: no real mobile network was used, so these numbers do not describe a 2G/EDGE link.',
        'Both clients ran on the same machine as the server.',
        payloadCap > 0
          ? 'The only constraint applied was the application payload cap. No OS-level network shaping or DevTools throttling was used.'
          : 'No OS-level network shaping or DevTools throttling was applied to this run.',
        'Payload figures exclude per-frame WebSocket and TCP overhead.',
      ],
    };

    fs.mkdirSync('test-results', { recursive: true });
    const suffix = payloadCap > 0 ? `-cap${payloadCap}` : '';
    const file = path.join('test-results', `measure-${new Date().toISOString().slice(0, 10)}${suffix}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nwritten to ${file}`);

    student.ws.close();
    volunteer.ws.close();
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

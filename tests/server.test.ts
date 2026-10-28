import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RtmsClient, RtmsJoinParams } from '../src/ingest/rtms-source.js';
import { RtmsSource } from '../src/ingest/rtms-source.js';
import type { SourceEvent } from '../src/ingest/types.js';
import type { SidebarMessage } from '../src/output/sidebar-channel.js';
import { createBatonServer } from '../src/server.js';
import { LlmConfigError } from '../src/llm/provider.js';
import { Session } from '../src/session.js';
import { decryptAppContext } from '../src/zoom/app-context.js';
import { urlValidationResponse, verifyWebhook } from '../src/zoom/webhook.js';
import { loadWorkshop } from '../src/workshop/schema.js';

const ZOOM = { clientId: 'cid', clientSecret: 'client-secret', secretToken: 'secret-token' };
const WORKSHOP = loadWorkshop('fixtures/workshops/design-sprint-lite.ja.json');

/** Encrypts like Zoom does (layout from developers.zoom.us/docs/zoom-apps/zoom-app-context/). */
function encryptContext(ctx: object, secret = ZOOM.clientSecret): string {
  const iv = randomBytes(12);
  const aad = Buffer.from('');
  const c = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(ctx)), c.final()]);
  const aadLen = Buffer.alloc(2);
  aadLen.writeUInt16LE(aad.length);
  const ctLen = Buffer.alloc(4);
  ctLen.writeUInt32LE(ct.length);
  return Buffer.concat([Buffer.from([iv.length]), iv, aadLen, aad, ctLen, ct, c.getAuthTag()]).toString('base64');
}

class FakeClient implements RtmsClient {
  joined?: RtmsJoinParams;
  leaves = 0;
  get left() {
    return this.leaves > 0;
  }
  transcript?: Parameters<RtmsClient['onTranscriptData']>[0];
  participant?: Parameters<RtmsClient['onParticipantEvent']>[0];
  leave_?: Parameters<RtmsClient['onLeave']>[0];
  constructor(private readonly joinOk = true) {}
  join(p: RtmsJoinParams) {
    this.joined = p;
    return this.joinOk;
  }
  leave() {
    this.leaves++;
    return true;
  }
  onTranscriptData(cb: FakeClient['transcript'] & {}) {
    this.transcript = cb;
    return true;
  }
  onParticipantEvent(cb: FakeClient['participant'] & {}) {
    this.participant = cb;
    return true;
  }
  onLeave(cb: FakeClient['leave_'] & {}) {
    this.leave_ = cb;
    return true;
  }
  say(userId: number, userName: string, text: string) {
    this.transcript!(Buffer.from(text), text.length, 0, { userId, userName, startTs: 1000, endTs: 3000 });
  }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('webhook signature', () => {
  const body = '{"event":"meeting.rtms_started"}';
  const sig = (ts: string, b = body, secret = ZOOM.secretToken) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${b}`).digest('hex')}`;

  it('accepts a correctly signed, fresh request', () => {
    expect(verifyWebhook(body, sig('1000'), '1000', ZOOM.secretToken, 1000)).toBe(true);
  });
  it('rejects wrong secret, tampered body, stale timestamp and missing headers', () => {
    expect(verifyWebhook(body, sig('1000', body, 'other'), '1000', ZOOM.secretToken, 1000)).toBe(false);
    expect(verifyWebhook(body + ' ', sig('1000'), '1000', ZOOM.secretToken, 1000)).toBe(false);
    expect(verifyWebhook(body, sig('1000'), '1000', ZOOM.secretToken, 1000 + 301)).toBe(false);
    expect(verifyWebhook(body, undefined, '1000', ZOOM.secretToken, 1000)).toBe(false);
    expect(verifyWebhook(body, 'v0=short', '1000', ZOOM.secretToken, 1000)).toBe(false);
  });
  it('answers url validation with HMAC(secret, plainToken)', () => {
    expect(urlValidationResponse('abc', 'tok')).toEqual({ plainToken: 'abc', encryptedToken: createHmac('sha256', 'tok').update('abc').digest('hex') });
  });
});

describe('Zoom app context', () => {
  const ctx = { typ: 'meeting', uid: 'u1', mid: 'MEETING==', ts: 1, exp: Date.now() + 60_000 };
  it('decrypts a valid header', () => {
    expect(decryptAppContext(encryptContext(ctx), ZOOM.clientSecret)?.mid).toBe('MEETING==');
  });
  it('rejects wrong secret, expired context and garbage', () => {
    expect(decryptAppContext(encryptContext(ctx), 'wrong')).toBeUndefined();
    expect(decryptAppContext(encryptContext({ ...ctx, exp: Date.now() - 1 }), ZOOM.clientSecret)).toBeUndefined();
    expect(decryptAppContext(encryptContext({ ...ctx, exp: Math.floor(Date.now() / 1000) + 60 }), ZOOM.clientSecret)?.uid).toBe('u1'); // seconds
    expect(decryptAppContext('not base64 at all', ZOOM.clientSecret)).toBeUndefined();
  });
});

describe('RtmsSource', () => {
  it('turns SDK callbacks into SourceEvents and ends on leave', async () => {
    const client = new FakeClient();
    const src = new RtmsSource(client, 'm1', 20);
    expect(src.join({ meeting_uuid: 'm1', rtms_stream_id: 's1', server_urls: 'wss://x' })).toBe(true);
    const got: SourceEvent[] = [];
    const done = (async () => {
      for await (const ev of src.events()) got.push(ev);
    })();
    client.participant!('join', 0, [{ userId: 7, userName: '佐藤' }, { userId: 8 }]);
    client.say(7, '佐藤', '  はい  ');
    client.say(7, '佐藤', '   ');
    src.control('next_step');
    await new Promise((r) => setTimeout(r, 70));
    client.leave_!(0);
    await done;
    const t = got.find((e) => e.type === 'transcript');
    expect(t).toMatchObject({ speakerId: '7', speakerName: '佐藤', text: 'はい' });
    if (t?.type === 'transcript') expect(t.endMs - t.startMs).toBeLessThanOrEqual(2000);
    expect(got.filter((e) => e.type === 'transcript')).toHaveLength(1);
    expect(got.filter((e) => e.type === 'participant').map((e) => e.type === 'participant' && e.name)).toEqual(['佐藤', '']);
    expect(got.some((e) => e.type === 'control')).toBe(true);
    expect(got.filter((e) => e.type === 'tick').length).toBeGreaterThan(0);
    expect(got.at(-1)?.type).toBe('end');
    const times = got.map((e) => (e.type === 'transcript' ? e.endMs : e.atMs));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('ends immediately when join fails', async () => {
    const src = new RtmsSource(new FakeClient(false), 'm1');
    expect(src.join({ meeting_uuid: 'm1', rtms_stream_id: 's1', server_urls: 'x' })).toBe(false);
    const got: SourceEvent[] = [];
    for await (const ev of src.events()) got.push(ev);
    expect(got.map((e) => e.type)).toEqual(['end']);
  });
});

describe('server', () => {
  let close = () => {};
  afterEach(() => close());

  const feedbackFile = join(mkdtempSync(join(tmpdir(), 'baton-')), 'sub', 'feedback.jsonl');

  async function start(opts: { zoom?: typeof ZOOM } = { zoom: ZOOM }) {
    const clients: FakeClient[] = [];
    const baton = createBatonServer({
      zoom: opts.zoom,
      devMeetings: ['demo'],
      feedbackFile,
      createClient: async () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      newSession: (meetingId) => new Session({ meetingId, locale: 'ja', workshop: WORKSHOP }),
      log: () => {},
    });
    await new Promise<void>((r) => baton.server.listen(0, r));
    close = () => baton.close();
    const base = `http://localhost:${(baton.server.address() as AddressInfo).port}`;
    const post = (event: string, payload: object, sign = true) => {
      const body = JSON.stringify({ event, payload });
      const ts = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (sign) Object.assign(headers, { 'x-zm-request-timestamp': ts, 'x-zm-signature': `v0=${createHmac('sha256', ZOOM.secretToken).update(`v0:${ts}:${body}`).digest('hex')}` });
      return fetch(`${base}/webhook`, { method: 'POST', headers, body });
    };
    const tokenFor = async (init?: RequestInit, query = '') => {
      const res = await fetch(`${base}/${query}`, init);
      return { res, token: (await res.text()).match(/name="baton-token" content="([^"]*)"/)![1] };
    };
    return { baton, base, clients, post, tokenFor };
  }

  /** Reads SSE messages until `stop` says enough. */
  async function readEvents(url: string, stop: (msgs: SidebarMessage[]) => boolean): Promise<SidebarMessage[]> {
    const ac = new AbortController();
    const res = await fetch(url, { signal: ac.signal });
    const msgs: SidebarMessage[] = [];
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) msgs.push(JSON.parse(line.slice(6)));
      }
      if (stop(msgs)) break;
    }
    ac.abort();
    return msgs;
  }

  it('answers Zoom URL validation and rejects unsigned events', async () => {
    const { post } = await start();
    const v = await post('endpoint.url_validation', { plainToken: 'pt' }, false);
    expect(await v.json()).toEqual(urlValidationResponse('pt', ZOOM.secretToken));
    expect((await post('meeting.rtms_started', {}, false)).status).toBe(401);
  });

  it('webhook is disabled without Zoom credentials', async () => {
    const { post } = await start({});
    expect((await post('meeting.rtms_started', {})).status).toBe(503);
  });

  it('home page has the OWASP headers Zoom requires and a token only for a verified meeting', async () => {
    const { tokenFor } = await start();
    const anon = await tokenFor();
    for (const h of ['strict-transport-security', 'x-content-type-options', 'content-security-policy', 'referrer-policy']) expect(anon.res.headers.get(h)).toBeTruthy();
    expect(anon.token).toBe('');
    const forged = await tokenFor({ headers: { 'x-zoom-app-context': encryptContext({ typ: 'meeting', uid: 'u', mid: 'M', ts: 1, exp: Date.now() + 60_000 }, 'wrong') } });
    expect(forged.token).toBe('');
    expect((await tokenFor(undefined, '?meeting=not-a-demo')).token).toBe('');
    expect((await tokenFor(undefined, '?meeting=demo')).token).not.toBe('');
  });

  it('rtms_started → join → nudges and status reach the sidebar; next step and rtms_stopped work', async () => {
    const { base, clients, post, tokenFor, baton } = await start();
    const meeting = 'abc/DEF+123==';
    expect((await post('meeting.rtms_started', { meeting_uuid: meeting, rtms_stream_id: 's1', server_urls: 'wss://rtms' })).status).toBe(200);
    await post('meeting.rtms_started', { meeting_uuid: meeting, rtms_stream_id: 's1', server_urls: 'wss://rtms' }); // duplicate delivery
    await until(() => baton.meetings.has(meeting) && !!clients[0]?.joined);
    expect(clients).toHaveLength(1);
    expect(clients[0].joined).toMatchObject({ meeting_uuid: meeting, rtms_stream_id: 's1', client: 'cid', secret: 'client-secret' });

    const { token } = await tokenFor({ headers: { 'x-zoom-app-context': encryptContext({ typ: 'meeting', uid: 'u', mid: meeting, ts: 1, exp: Date.now() + 60_000 }) } });
    expect((await fetch(`${base}/events?token=bogus`)).status).toBe(401);

    const first = await readEvents(`${base}/events?token=${encodeURIComponent(token)}`, (m) => m.some((x) => x.type === 'status'));
    const status = first.find((m) => m.type === 'status');
    expect(status?.type === 'status' && status.status.step?.index).toBe(0);

    expect((await fetch(`${base}/next?token=${encodeURIComponent(token)}`, { method: 'POST' })).status).toBe(200);
    const after = await readEvents(`${base}/events?token=${encodeURIComponent(token)}`, (m) =>
      m.some((x) => x.type === 'status' && x.status.step?.index === 1) && m.some((x) => x.type === 'nudge' && x.nudge.ruleId === 'step_transition'),
    );
    expect(after.some((x) => x.type === 'nudge' && x.nudge.ruleId === 'step_transition')).toBe(true);

    await post('meeting.rtms_stopped', { meeting_uuid: meeting, rtms_stream_id: 's1' });
    await until(() => !baton.meetings.has(meeting));
    expect(clients[0].left).toBe(true);
    const ended = await readEvents(`${base}/events?token=${encodeURIComponent(token)}`, (m) => m.some((x) => x.type === 'status' && x.status.ended));
    expect(ended.some((x) => x.type === 'status' && x.status.ended)).toBe(true);
    expect((await fetch(`${base}/next?token=${encodeURIComponent(token)}`, { method: 'POST' })).status).toBe(409);
  });

  it('records adopted/ignored verdicts without nudge text and shares them with other sidebars', async () => {
    const { base, baton, tokenFor } = await start();
    const { token } = await tokenFor(undefined, '?meeting=demo');
    const q = `?token=${encodeURIComponent(token)}`;
    let resolveEnd!: () => void;
    const ended = new Promise<void>((r) => (resolveEnd = r));
    void baton.startMeeting('demo', { async *events() { yield { type: 'tick' as const, atMs: 0 }; await ended; yield { type: 'end' as const, atMs: 1 }; } });
    const [first] = await readEvents(`${base}/events${q}`, (m) => m.some((x) => x.type === 'nudge')).then((m) => m.filter((x) => x.type === 'nudge'));
    const nudge = first.type === 'nudge' ? first.nudge : undefined!;
    const send = (body: object) => fetch(`${base}/feedback${q}`, { method: 'POST', body: JSON.stringify(body) });

    expect((await send({ nudgeId: nudge.id, verdict: 'maybe' })).status).toBe(400);
    expect((await send({ nudgeId: 'nope', verdict: 'adopted' })).status).toBe(404);
    expect((await fetch(`${base}/feedback?token=bad`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await send({ nudgeId: nudge.id, verdict: 'ignored' })).status).toBe(200);
    expect((await send({ nudgeId: nudge.id, verdict: 'adopted' })).status).toBe(200);

    const replayed = await readEvents(`${base}/events${q}`, (m) => m.some((x) => x.type === 'feedback'));
    expect(replayed.filter((x) => x.type === 'feedback')).toEqual([{ type: 'feedback', nudgeId: nudge.id, verdict: 'adopted' }]);

    const rows = readFileSync(feedbackFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.verdict)).toEqual(['ignored', 'adopted']);
    expect(rows[0]).toMatchObject({ ruleId: nudge.ruleId, type: nudge.type, priority: nudge.priority });
    expect(readFileSync(feedbackFile, 'utf8')).not.toContain(nudge.message.slice(0, 6)); // privacy: no nudge text
    expect(readFileSync(feedbackFile, 'utf8')).not.toContain('demo'); // meeting id hashed
    resolveEnd();
    expect(existsSync(feedbackFile)).toBe(true);
  });

  it('url validation never signs a string that could double as a webhook signature (HMAC oracle)', async () => {
    const { post } = await start();
    expect((await post('endpoint.url_validation', { plainToken: 'v0:1700000000:{"event":"meeting.rtms_stopped"}' }, false)).status).toBe(400);
    expect((await post('endpoint.url_validation', { plainToken: 'qgg8vlvZRS6UYooatFL8Aw' }, false)).status).toBe(200);
  });

  it('leaves the native client exactly once: duplicate rtms_stopped, close(), and when the SDK ended the stream itself', async () => {
    const { clients, post, baton } = await start();
    await post('meeting.rtms_started', { meeting_uuid: 'm1', rtms_stream_id: 's1', server_urls: 'wss://x' });
    await post('meeting.rtms_started', { meeting_uuid: 'm2', rtms_stream_id: 's2', server_urls: 'wss://x' });
    await until(() => clients.length === 2 && clients.every((c) => c.joined));
    await post('meeting.rtms_stopped', { meeting_uuid: 'm1', rtms_stream_id: 's1' });
    await post('meeting.rtms_stopped', { meeting_uuid: 'm1', rtms_stream_id: 's1' });
    clients[1].leave_!(0); // SDK-side leave: the stream ends and the client must still be released
    await until(() => baton.meetings.size === 0);
    baton.close();
    expect(clients.map((c) => c.leaves)).toEqual([1, 1]);
  });

  it('a restarted RTMS stream publishes fresh nudge ids, so open sidebars do not drop them as duplicates', async () => {
    const { base, clients, post, tokenFor } = await start();
    const { token } = await tokenFor({ headers: { 'x-zoom-app-context': encryptContext({ typ: 'meeting', uid: 'u', mid: 'M', ts: 1, exp: Date.now() + 60_000 }) } });
    const events = `${base}/events?token=${encodeURIComponent(token)}`;
    const goals = (m: SidebarMessage[]) => m.flatMap((x) => (x.type === 'nudge' && x.nudge.id.endsWith(':step_transition:goal') ? [x.nudge.id] : []));
    await post('meeting.rtms_started', { meeting_uuid: 'M', rtms_stream_id: 's1', server_urls: 'wss://x' });
    await readEvents(events, (m) => goals(m).length === 1); // run 1 announced step 1
    await post('meeting.rtms_started', { meeting_uuid: 'M', rtms_stream_id: 's2', server_urls: 'wss://x' }); // replaces s1
    await until(() => !!clients[1]?.joined);
    expect(clients[0].leaves).toBe(1);
    const msgs = await readEvents(events, (m) => goals(m).length === 2);
    const ids = goals(msgs);
    expect(ids[0]).not.toBe(ids[1]); // same rule key, distinct published ids
    const last = msgs.filter((x) => x.type === 'status').at(-1);
    expect(last?.type === 'status' && last.status.ended).toBe(false); // the replaced run's late "ended" stays quiet
  });

  it('a replay demo answers next-step with 409 not_controllable, and replayed status carries its age', async () => {
    const { base, baton, tokenFor } = await start();
    const { token } = await tokenFor(undefined, '?meeting=demo');
    void baton.startMeeting('demo', { async *events() { yield { type: 'tick' as const, atMs: 0 }; await new Promise(() => {}); } });
    await until(() => baton.meetings.has('demo'));
    const res = await fetch(`${base}/next?token=${encodeURIComponent(token)}`, { method: 'POST' });
    expect([res.status, (await res.json()).error]).toEqual([409, 'not_controllable']);
    await new Promise((r) => setTimeout(r, 50));
    const [status] = await readEvents(`${base}/events?token=${encodeURIComponent(token)}`, (m) => m.some((x) => x.type === 'status'));
    expect(status.type === 'status' && status.ageMs).toBeGreaterThanOrEqual(40);
  });
});

describe('Session.llmInBackground', () => {
  it('does not wait for a slow periodic extraction, but the final one is awaited and fatal errors surface', async () => {
    let release!: () => void;
    let calls = 0;
    const llm = {
      analyze: async () => {
        calls++;
        await new Promise<void>((r) => (release = r));
        return { decisions: [{ id: null, text: 'ship it' }], actionItems: [], openQuestions: [], unresolvedTopic: null };
      },
    };
    const session = new Session({ meetingId: 'm', locale: 'en', llm, llmInBackground: true, llmTracker: { intervalMs: 1000, maxPending: 100, windowMs: 600_000 } });
    await session.handle({ type: 'transcript', meetingId: 'm', speakerId: '1', speakerName: 'A', text: 'hi', startMs: 0, endMs: 500 });
    const t0 = performance.now();
    await session.handle({ type: 'tick', atMs: 2000 }); // due: starts a background call
    await session.handle({ type: 'tick', atMs: 3000 }); // still in flight: no second call, no wait
    expect(performance.now() - t0).toBeLessThan(200);
    expect(calls).toBe(1);
    const end = session.handle({ type: 'end', atMs: 4000 }); // waits for the in-flight call
    release();
    await end;
    expect(session.state.decisions.map((d) => d.text)).toEqual(['ship it']);

    const failing = new Session({ meetingId: 'm', locale: 'en', llm: { analyze: async () => { throw new LlmConfigError('no key'); } }, llmInBackground: true, llmTracker: { intervalMs: 1000, maxPending: 100, windowMs: 600_000 } });
    await failing.handle({ type: 'transcript', meetingId: 'm', speakerId: '1', speakerName: 'A', text: 'hi', startMs: 0, endMs: 500 });
    await failing.handle({ type: 'tick', atMs: 2000 });
    await new Promise((r) => setTimeout(r, 10));
    await expect(failing.handle({ type: 'tick', atMs: 3000 })).rejects.toBeInstanceOf(LlmConfigError);
  });
});

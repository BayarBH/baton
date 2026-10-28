import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { RtmsSource, type RtmsClient } from './ingest/rtms-source.js';
import type { TranscriptSource } from './ingest/source.js';
import { SidebarChannel, type SidebarMessage, type Verdict } from './output/sidebar-channel.js';
import type { Session } from './session.js';
import { decryptAppContext } from './zoom/app-context.js';
import { urlValidationResponse, verifyWebhook } from './zoom/webhook.js';

export interface ZoomCredentials {
  clientId: string;
  clientSecret: string;
  /** Webhook "Secret Token" from the Marketplace app. */
  secretToken: string;
}

export interface BatonServerConfig {
  newSession(meetingId: string): Session;
  /** Absent: the webhook endpoint is disabled (local demo / sidebar work). */
  zoom?: ZoomCredentials;
  /** Defaults to the native `@zoom/rtms` SDK (linux-x64 / darwin-arm64 only). */
  createClient?: () => Promise<RtmsClient>;
  /** Meeting ids a plain browser may open as `/?meeting=<id>` without Zoom app context (local demo only). */
  devMeetings?: string[];
  /** Append-only JSONL of the facilitator's adopted/ignored verdicts (no nudge text). Omit to not persist. */
  feedbackFile?: string;
  log?: (msg: string) => void;
}

/** A running meeting: what the webhook and the sidebar can do to it. */
export interface LiveMeeting {
  streamId?: string;
  /** Absent when the source cannot be steered (e.g. a replay demo). */
  control?(action: 'next_step'): void;
  /** Must be idempotent. */
  stop(): void;
}

const APP_DIR = join(import.meta.dirname, '..', 'app');
const STATIC: Record<string, string> = { '/app/sidebar.js': 'text/javascript; charset=utf-8', '/app/sidebar.css': 'text/css; charset=utf-8' };
// Zoom Apps blocks a home URL whose HTML lacks these OWASP headers (developers.zoom.us/docs/zoom-apps/security/owasp/).
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://appssdk.zoom.us; style-src 'self'; connect-src 'self' https://*.zoom.us wss://*.zoom.us; img-src 'self' data:; frame-ancestors 'self' https://*.zoom.us",
};
const TOKEN_TTL_MS = 12 * 3600_000;
const FORGET_AFTER_MS = 3600_000;

export function createBatonServer(cfg: BatonServerConfig) {
  const log = cfg.log ?? ((m: string) => console.log(`[baton] ${m}`));
  const channel = new SidebarChannel();
  const meetings = new Map<string, LiveMeeting>();
  const forgetTimers = new Map<string, NodeJS.Timeout>();
  const files = Object.fromEntries(['/index.html', ...Object.keys(STATIC)].map((p) => [p, readFileSync(join(APP_DIR, p.replace(/^\/app\//, '/')), 'utf8')]));

  // Sidebar access: the home URL issues a token bound to the meeting Zoom says the user is in. Key dies with the process.
  const key = randomBytes(32);
  const sign = (id: string, exp: number) => createHmac('sha256', key).update(`${id}\n${exp}`).digest('base64url');
  const issueToken = (id: string) => {
    const exp = Date.now() + TOKEN_TTL_MS;
    return `${Buffer.from(id).toString('base64url')}.${exp}.${sign(id, exp)}`;
  };
  const meetingOf = (token: string | null): string | undefined => {
    const [a, b, c] = (token ?? '').split('.');
    const exp = Number(b);
    if (!c || !(exp > Date.now())) return undefined;
    const id = Buffer.from(a, 'base64url').toString('utf8');
    const want = Buffer.from(sign(id, exp));
    const got = Buffer.from(c);
    return got.length === want.length && timingSafeEqual(got, want) ? id : undefined;
  };

  /** Runs a session over a source, pushing nudges and status to the meeting's sidebars. */
  async function runMeeting(meetingId: string, source: TranscriptSource, live: LiveMeeting): Promise<void> {
    meetings.set(meetingId, live);
    clearTimeout(forgetTimers.get(meetingId));
    const session = cfg.newSession(meetingId);
    // A run replaced by a newer stream for the same meeting goes quiet, so its late "ended" cannot overwrite the live one.
    const publish = (msg: SidebarMessage) => meetings.get(meetingId) === live && channel.publish(meetingId, msg);
    // Rule keys repeat across runs of one meeting (RTMS stopped and restarted); sidebars dedupe by id.
    const run = randomBytes(4).toString('hex');
    const publishStatus = () => publish({ type: 'status', status: session.status() });
    let lastKey = '';
    let lastAt = -Infinity;
    publishStatus();
    try {
      for await (const ev of source.events()) {
        for (const nudge of await session.handle(ev)) publish({ type: 'nudge', nudge: { ...nudge, id: `${run}:${nudge.id}` } });
        if (ev.type === 'transcript' || ev.type === 'participant') continue;
        const s = session.status();
        const k = `${s.step?.index}|${s.ended}`;
        // On step change, plus a periodic resync for the sidebar's local countdown.
        if (k !== lastKey || ev.atMs - lastAt >= 10_000) {
          publishStatus();
          lastKey = k;
          lastAt = ev.atMs;
        }
      }
    } catch (err) {
      log(`meeting ${short(meetingId)}: session stopped (${(err as Error).name})`); // never the message: it may quote transcript
      live.stop();
      publish({ type: 'status', status: { ...session.status(), ended: true, step: undefined } });
    } finally {
      if (meetings.get(meetingId) === live) {
        meetings.delete(meetingId);
        clearTimeout(forgetTimers.get(meetingId));
        forgetTimers.set(meetingId, setTimeout(() => (forgetTimers.delete(meetingId), meetings.has(meetingId) || channel.forget(meetingId)), FORGET_AFTER_MS).unref());
      }
    }
  }

  async function startRtms(p: Record<string, unknown>, zoom: ZoomCredentials): Promise<void> {
    const { meeting_uuid: meetingId, rtms_stream_id: streamId, server_urls: serverUrls } = p;
    if (typeof meetingId !== 'string' || typeof streamId !== 'string' || typeof serverUrls !== 'string') return log('rtms_started without meeting_uuid / rtms_stream_id / server_urls');
    const prev = meetings.get(meetingId);
    if (prev?.streamId === streamId) return; // duplicate delivery
    prev?.stop();
    // Reserve the slot before awaiting so a concurrent duplicate is ignored.
    // eslint-disable-next-line prefer-const -- assigned after the closures below that read it
    let source: RtmsSource | undefined;
    let client: RtmsClient | undefined;
    let stopped = false;
    const live: LiveMeeting = {
      streamId,
      control: (a) => source?.control(a),
      stop: () => {
        if (stopped) return; // the native client must be left exactly once: a second leave() dereferences a released SDK
        stopped = true;
        source?.stop();
        try {
          client?.leave();
        } catch {
          /* already gone */
        }
      },
    };
    meetings.set(meetingId, live);
    const release = () => meetings.get(meetingId) === live && meetings.delete(meetingId);
    try {
      client = await (cfg.createClient ?? nativeClient)();
    } catch (err) {
      release();
      throw err;
    }
    source = new RtmsSource(client, meetingId);
    if (stopped || meetings.get(meetingId) !== live) return void release(); // stopped while loading the SDK
    if (!source.join({ meeting_uuid: meetingId, rtms_stream_id: streamId, server_urls: serverUrls, client: zoom.clientId, secret: zoom.clientSecret })) {
      release();
      return log(`meeting ${short(meetingId)}: RTMS join failed`);
    }
    log(`meeting ${short(meetingId)}: RTMS joined`);
    await runMeeting(meetingId, source, live);
    live.stop(); // releases the client (stops SDK polling) also when the SDK ended the stream itself via onLeave
    log(`meeting ${short(meetingId)}: ended`);
  }

  /** Adopted/ignored verdict from a sidebar: shared with the meeting's other sidebars and recorded for later analysis. */
  async function feedback(req: IncomingMessage, res: ServerResponse, meetingId: string): Promise<void> {
    let body: { nudgeId?: unknown; verdict?: unknown };
    try {
      body = JSON.parse((await readBody(req, 4096)) ?? '');
    } catch {
      return json(res, 400, { error: 'invalid_json' });
    }
    const { nudgeId, verdict } = body;
    if (typeof nudgeId !== 'string' || (verdict !== 'adopted' && verdict !== 'ignored')) return json(res, 400, { error: 'invalid_feedback' });
    const nudge = channel.nudge(meetingId, nudgeId);
    if (!nudge) return json(res, 404, { error: 'unknown_nudge' });
    channel.publish(meetingId, { type: 'feedback', nudgeId, verdict: verdict as Verdict });
    if (cfg.feedbackFile) {
      // Privacy: rule metadata only; meeting and nudge ids are hashed, the message (names, items) is never stored.
      const hash = (x: string) => createHash('sha256').update(x).digest('hex').slice(0, 16);
      const record = { at: new Date().toISOString(), meeting: hash(meetingId), nudge: hash(`${meetingId}\n${nudgeId}`), ruleId: nudge.ruleId, type: nudge.type, priority: nudge.priority, atMs: nudge.atMs, verdict };
      mkdirSync(dirname(cfg.feedbackFile), { recursive: true });
      appendFileSync(cfg.feedbackFile, JSON.stringify(record) + '\n');
    }
    json(res, 200, {});
  }

  async function webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const zoom = cfg.zoom;
    if (!zoom) return json(res, 503, { error: 'zoom_not_configured' });
    const raw = await readBody(req);
    if (raw === undefined) return json(res, 413, { error: 'too_large' });
    let body: { event?: unknown; payload?: Record<string, unknown> };
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: 'invalid_json' });
    }
    const payload = body.payload ?? {};
    if (body.event === 'endpoint.url_validation') {
      // Answered unsigned (as Zoom's sample does), so only sign short opaque tokens: signing an arbitrary string here
      // would hand out valid x-zm-signature values for "v0:{ts}:{body}" (same key, same HMAC).
      const t = payload.plainToken;
      return typeof t === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(t) ? json(res, 200, urlValidationResponse(t, zoom.secretToken)) : json(res, 400, { error: 'bad_plain_token' });
    }
    if (!verifyWebhook(raw, header(req, 'x-zm-signature'), header(req, 'x-zm-request-timestamp'), zoom.secretToken)) return json(res, 401, { error: 'invalid_signature' });
    json(res, 200, {}); // acknowledge before doing RTMS work
    if (body.event === 'meeting.rtms_started') {
      startRtms(payload, zoom).catch((err) => log(`rtms_started failed: ${(err as Error).message}`));
    } else if (body.event === 'meeting.rtms_stopped') {
      const live = typeof payload.meeting_uuid === 'string' ? meetings.get(payload.meeting_uuid) : undefined;
      if (live && (live.streamId === undefined || live.streamId === payload.rtms_stream_id)) live.stop();
    }
  }

  function home(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const ctxHeader = header(req, 'x-zoom-app-context');
    const ctx = ctxHeader && cfg.zoom ? decryptAppContext(ctxHeader, cfg.zoom.clientSecret) : undefined;
    const dev = url.searchParams.get('meeting');
    const meetingId = ctx?.pid ?? ctx?.mid ?? (dev && cfg.devMeetings?.includes(dev) ? dev : undefined);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(files['/index.html'].replace('{{TOKEN}}', meetingId ? issueToken(meetingId) : ''));
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // HEAD is answered like GET (Node drops the body): Zoom's Marketplace checks the home URL's OWASP headers with it.
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const route = `${method} ${url.pathname}`;
    if (route === 'GET /') return home(req, res, url);
    if (method === 'GET' && STATIC[url.pathname]) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': STATIC[url.pathname] });
      return void res.end(files[url.pathname]);
    }
    if (route === 'GET /healthz') return json(res, 200, { ok: true, meetings: meetings.size });
    if (route === 'POST /webhook') {
      webhook(req, res).catch((err) => {
        log(`webhook error: ${(err as Error).name}`);
        if (!res.headersSent) json(res, 500, { error: 'internal' });
      });
      return;
    }
    const meetingId = meetingOf(url.searchParams.get('token'));
    if (route === 'GET /events') return meetingId ? channel.subscribe(meetingId, res) : json(res, 401, { error: 'invalid_token' });
    if (route === 'POST /feedback') {
      if (!meetingId) return json(res, 401, { error: 'invalid_token' });
      feedback(req, res, meetingId).catch((err) => {
        log(`feedback error: ${(err as Error).name}`);
        if (!res.headersSent) json(res, 500, { error: 'internal' });
      });
      return;
    }
    if (route === 'POST /next') {
      if (!meetingId) return json(res, 401, { error: 'invalid_token' });
      const live = meetings.get(meetingId);
      if (!live) return json(res, 409, { error: 'meeting_not_running' });
      if (!live.control) return json(res, 409, { error: 'not_controllable' });
      live.control('next_step');
      return json(res, 200, {});
    }
    json(res, 404, { error: 'not_found' });
  });

  return {
    server,
    channel,
    meetings,
    /** Run a non-RTMS source (e.g. a replay demo) as a meeting. */
    startMeeting: (meetingId: string, source: TranscriptSource, live: LiveMeeting = { stop() {} }) => runMeeting(meetingId, source, live),
    close(): void {
      for (const live of meetings.values()) live.stop();
      for (const t of forgetTimers.values()) clearTimeout(t);
      channel.close();
      server.close();
    },
  };
}

/** Loads the native SDK lazily so the server (and tests) run on platforms the SDK does not ship for. */
async function nativeClient(): Promise<RtmsClient> {
  const name = '@zoom/rtms';
  try {
    const rtms = (await import(name)).default;
    return new rtms.Client();
  } catch (err) {
    throw new Error(`@zoom/rtms could not be loaded (it ships for linux-x64 / darwin-arm64 only; on Windows run the server in WSL2 or Docker): ${(err as Error).message}`);
  }
}

async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const short = (id: string) => id.slice(0, 8);

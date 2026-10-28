import type { ServerResponse } from 'node:http';
import type { Nudge } from '../policy/types.js';
import type { SessionStatus } from '../session.js';

export type Verdict = 'adopted' | 'ignored';
export type SidebarMessage =
  /** ageMs: set when a cached status is replayed, so the sidebar's local countdown does not start from a stale point. */
  | { type: 'status'; status: SessionStatus; ageMs?: number }
  | { type: 'nudge'; nudge: Nudge }
  | { type: 'feedback'; nudgeId: string; verdict: Verdict };

const HISTORY = 50;

interface History {
  status?: SidebarMessage & { type: 'status' };
  statusAt?: number;
  nudges: SidebarMessage[];
  feedback: Map<string, SidebarMessage>;
}

/**
 * Per-meeting push to sidebars over Server-Sent Events (one-way is all the sidebar needs; actions go over POST).
 * Late joiners get the latest status and recent nudges replayed.
 */
export class SidebarChannel {
  private readonly subs = new Map<string, Set<ServerResponse>>();
  private readonly history = new Map<string, History>();
  private readonly keepalive = setInterval(() => {
    for (const set of this.subs.values()) for (const res of set) res.write(': ping\n\n');
  }, 25_000).unref();

  subscribe(meetingId: string, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const h = this.history.get(meetingId);
    const status: SidebarMessage[] = h?.status ? [{ ...h.status, ageMs: Date.now() - h.statusAt! }] : [];
    for (const m of [...status, ...(h?.nudges ?? []), ...(h?.feedback.values() ?? [])]) send(res, m);
    const set = this.subs.get(meetingId) ?? new Set();
    this.subs.set(meetingId, set);
    set.add(res);
    res.on('close', () => {
      set.delete(res);
      if (!set.size) this.subs.delete(meetingId);
    });
  }

  publish(meetingId: string, msg: SidebarMessage): void {
    const h: History = this.history.get(meetingId) ?? { nudges: [], feedback: new Map() };
    this.history.set(meetingId, h);
    if (msg.type === 'status') {
      h.status = msg;
      h.statusAt = Date.now();
    } else if (msg.type === 'feedback') h.feedback.set(msg.nudgeId, msg); // last verdict wins
    else h.nudges = [...h.nudges, msg].slice(-HISTORY);
    for (const res of this.subs.get(meetingId) ?? []) send(res, msg);
  }

  /** A nudge recently sent to this meeting (the ones a sidebar can still show). */
  nudge(meetingId: string, nudgeId: string): Nudge | undefined {
    for (const m of this.history.get(meetingId)?.nudges ?? []) if (m.type === 'nudge' && m.nudge.id === nudgeId) return m.nudge;
    return undefined;
  }

  /** Drop a finished meeting's history (the server calls this a while after the meeting ends). */
  forget(meetingId: string): void {
    this.history.delete(meetingId);
  }

  close(): void {
    clearInterval(this.keepalive);
    for (const set of this.subs.values()) for (const res of set) res.end();
    this.subs.clear();
  }
}

function send(res: ServerResponse, msg: SidebarMessage): void {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

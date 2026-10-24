import { dirname, resolve } from 'node:path';
import { loadFixture, ReplaySource } from './ingest/replay-source.js';
import type { Nudge } from './policy/types.js';
import { run, Session, type SessionConfig } from './session.js';
import { loadWorkshop } from './workshop/schema.js';

export async function replayFile(
  path: string,
  opts: { speed?: number; onNudge?: (n: Nudge) => void; session?: Partial<SessionConfig> } = {},
): Promise<{ nudges: Nudge[]; session: Session }> {
  const fixture = loadFixture(path);
  const workshop = fixture.workshop ? loadWorkshop(resolve(dirname(path), fixture.workshop)) : undefined;
  const session = new Session({ meetingId: fixture.meetingId, locale: fixture.locale, workshop, ...opts.session });
  const nudges = await run(new ReplaySource(fixture, opts.speed ?? Infinity), session, opts.onNudge);
  return { nudges, session };
}

export const mmss = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

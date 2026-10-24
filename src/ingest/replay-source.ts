import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { TranscriptSource } from './source.js';
import { eventTime, type SourceEvent } from './types.js';

const time = z.string().regex(/^\d+:[0-5]\d$/, 'expected "mm:ss"');

export const FixtureSchema = z
  .strictObject({
  meetingId: z.string(),
  locale: z.enum(['ja', 'zh', 'en']),
  /** Path to a workshop script, relative to the fixture file. Absent = meeting mode. */
  workshop: z.string().optional(),
  endAt: time,
  participants: z.array(z.strictObject({ id: z.string(), name: z.string(), joinAt: time.default('0:00'), leaveAt: time.optional() })),
  events: z.array(
    z.union([
      z.strictObject({ at: time, dur: z.number().positive(), speaker: z.string(), text: z.string(), lang: z.enum(['ja', 'zh', 'en', 'mixed']).optional() }),
      z.strictObject({ at: time, control: z.literal('next_step') }),
    ]),
  ),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const p of f.participants) {
      if (seen.has(p.id)) ctx.addIssue({ code: 'custom', message: `duplicate participant id "${p.id}"` });
      seen.add(p.id);
      if (p.leaveAt && toMs(p.leaveAt) < toMs(p.joinAt)) ctx.addIssue({ code: 'custom', message: `participant "${p.id}": leaveAt before joinAt` });
    }
  });
export type Fixture = z.infer<typeof FixtureSchema>;

export const toMs = (mmss: string) => {
  const [m, s] = mmss.split(':').map(Number);
  return (m * 60 + s) * 1000;
};

export function loadFixture(path: string): Fixture {
  return FixtureSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function fixtureEvents(f: Fixture): SourceEvent[] {
  const names = new Map(f.participants.map((p) => [p.id, p.name]));
  const out: SourceEvent[] = [];
  for (const p of f.participants) {
    out.push({ type: 'participant', meetingId: f.meetingId, participantId: p.id, name: p.name, kind: 'join', atMs: toMs(p.joinAt) });
    if (p.leaveAt) out.push({ type: 'participant', meetingId: f.meetingId, participantId: p.id, name: p.name, kind: 'leave', atMs: toMs(p.leaveAt) });
  }
  for (const e of f.events) {
    const startMs = toMs(e.at);
    if ('control' in e) out.push({ type: 'control', action: e.control, atMs: startMs });
    else {
      const speakerName = names.get(e.speaker);
      if (!speakerName) throw new Error(`fixture: unknown speaker "${e.speaker}" at ${e.at}`);
      out.push({ type: 'transcript', meetingId: f.meetingId, speakerId: e.speaker, speakerName, text: e.text, startMs, endMs: startMs + e.dur * 1000, lang: e.lang });
    }
  }
  return out.sort((a, b) => eventTime(a) - eventTime(b)); // stable: same-time events keep fixture order
}

/** Replays a fixture on its original timestamps, interleaving 1s ticks. speed=Infinity replays instantly. */
export class ReplaySource implements TranscriptSource {
  constructor(
    private readonly fixture: Fixture,
    private readonly speed = 1,
    private readonly tickMs = 1000,
  ) {
    if (!(tickMs > 0)) throw new RangeError('tickMs must be > 0');
    if (!(speed > 0)) throw new RangeError('speed must be > 0');
  }

  async *events(): AsyncIterable<SourceEvent> {
    const evs = fixtureEvents(this.fixture);
    const endMs = Math.max(toMs(this.fixture.endAt), ...evs.map(eventTime));
    let clock = 0;
    let i = 0;
    const t0 = performance.now();
    // Sleep against an absolute anchor so timer granularity (~15ms on Windows) does not accumulate.
    const advance = async (to: number) => {
      const wait = t0 + to / this.speed - performance.now();
      if (Number.isFinite(this.speed) && wait >= 1) await sleep(wait);
      clock = Math.max(clock, to);
    };
    for (let t = 0; t <= endMs || i < evs.length; t += this.tickMs) {
      while (i < evs.length && eventTime(evs[i]) <= t) {
        await advance(eventTime(evs[i]));
        yield evs[i++];
      }
      await advance(t);
      yield { type: 'tick', atMs: t };
    }
    yield { type: 'end', atMs: clock };
  }
}

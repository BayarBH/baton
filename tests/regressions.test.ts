// Regressions from internal QA round 1.
import { describe, expect, it } from 'vitest';
import { FixtureSchema, ReplaySource } from '../src/ingest/replay-source.js';
import { PolicyEngine } from '../src/policy/engine.js';
import type { Candidate } from '../src/policy/types.js';
import { mmss } from '../src/replay.js';
import { run, Session } from '../src/session.js';
import { WorkshopScriptSchema, type WorkshopScript } from '../src/workshop/schema.js';

const replay = async (fixture: unknown, workshop?: WorkshopScript) => {
  const f = FixtureSchema.parse(fixture);
  const session = new Session({ meetingId: f.meetingId, locale: f.locale, workshop });
  return { nudges: await run(new ReplaySource(f, Infinity), session), session };
};
const talk = (speaker: string, from: number, to: number, every = 30) =>
  Array.from({ length: Math.floor((to - from) / every) }, (_, k) => ({ at: mmss((from + k * every) * 1000), dur: 5, speaker, text: '…' }));
const people = (...ids: string[]) => ids.map((id) => ({ id, name: id.toUpperCase() }));
const step = (id: string, min: number, extra = {}) => ({ id, name: id, timeboxMin: min, goal: 'g', transition: 'on_timebox', ...extra });

describe('silent_participant', () => {
  it('does not count heads-down (silentWork) time as silence', async () => {
    const ws = WorkshopScriptSchema.parse({ id: 'w', title: 't', locale: 'en', steps: [step('sketch', 12, { silentWork: true }), step('talk', 10)] });
    const { nudges } = await replay({ meetingId: 'm', locale: 'en', endAt: '20:00', participants: people('a', 'b', 'c'), events: talk('a', 12 * 60 + 5, 20 * 60) }, ws);
    expect(nudges.filter((n) => n.ruleId === 'silent_participant')).toEqual([]);
  });

  it('names each person once per silent stretch, even as the silent set grows', async () => {
    const { nudges } = await replay({
      meetingId: 'm', locale: 'en', endAt: '25:00',
      participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', joinAt: '3:00' }, { id: 'd', name: 'D', joinAt: '6:00' }],
      events: talk('a', 0, 25 * 60),
    });
    const msgs = nudges.filter((n) => n.ruleId === 'silent_participant').map((n) => n.message);
    expect(msgs.join(' ').match(/\bB\b/g)).toHaveLength(1);
    expect(msgs.join(' ')).toMatch(/\bC\b/);
    expect(msgs.join(' ')).toMatch(/\bD\b/);
  });

  it('treats someone who keeps talking after a "leave" as present', async () => {
    const { nudges } = await replay({
      meetingId: 'm', locale: 'en', endAt: '20:00',
      participants: [{ id: 'a', name: 'A', leaveAt: '1:00' }, { id: 'b', name: 'B' }],
      events: talk('a', 90, 20 * 60),
    });
    expect(nudges.some((n) => n.ruleId === 'silent_participant' && n.message.includes('B'))).toBe(true);
  });
});

describe('timebox', () => {
  it('rejects warnings >= timebox, unknown keys', () => {
    expect(WorkshopScriptSchema.safeParse({ id: 'w', title: 't', locale: 'en', steps: [step('s', 5, { warnAtRemainingMin: [10] })] }).success).toBe(false);
    expect(WorkshopScriptSchema.safeParse({ id: 'w', title: 't', locale: 'en', steps: [step('s', 5, { warnAtRemaningMin: [1] })] }).success).toBe(false);
  });

  it('time is up exactly on time even right after a late warning (P1 skips cooldown)', async () => {
    const ws = WorkshopScriptSchema.parse({ id: 'w', title: 't', locale: 'en', steps: [step('s', 5, { transition: 'manual', warnAtRemainingMin: [0.5] })] });
    const { nudges } = await replay({ meetingId: 'm', locale: 'en', endAt: '6:00', participants: people('a'), events: [] }, ws);
    expect(nudges.map((n) => `${mmss(n.atMs)} ${n.ruleId}`)).toEqual(['00:00 step_transition', '04:30 timebox_warning', '05:00 timebox_exceeded']);
    expect(nudges[1].message).toContain('less than a minute');
  });

  it('last on_timebox step stays current and prompts a wrap-up', async () => {
    const ws = WorkshopScriptSchema.parse({ id: 'w', title: 't', locale: 'en', steps: [step('a', 2), step('b', 2)] });
    const { nudges } = await replay({ meetingId: 'm', locale: 'en', endAt: '5:00', participants: people('a'), events: [] }, ws);
    expect(nudges.at(-1)).toMatchObject({ ruleId: 'timebox_exceeded', atMs: 4 * 60_000 });
    expect(nudges.at(-1)?.message).toContain('wrap up');
  });
});

describe('ingest', () => {
  it('yields events that fall after the last tick or after endAt', async () => {
    const f = FixtureSchema.parse({ meetingId: 'm', locale: 'en', endAt: '0:10', participants: people('a'), events: [{ at: '0:30', dur: 2.5, speaker: 'a', text: 'x' }] });
    const evs = [];
    for await (const e of new ReplaySource(f, Infinity).events()) evs.push(e);
    expect(evs.filter((e) => e.type === 'transcript')).toHaveLength(1);
    expect(evs.at(-1)).toMatchObject({ type: 'end', atMs: 33_000 });
  });

  it('rejects leaveAt before joinAt and duplicate ids', () => {
    expect(FixtureSchema.safeParse({ meetingId: 'm', locale: 'en', endAt: '1:00', participants: [{ id: 'a', name: 'A', joinAt: '0:30', leaveAt: '0:10' }], events: [] }).success).toBe(false);
    expect(FixtureSchema.safeParse({ meetingId: 'm', locale: 'en', endAt: '1:00', participants: [...people('a'), ...people('a')], events: [] }).success).toBe(false);
  });

  it('does not double-count overlapping segments from one speaker', async () => {
    const { session } = await replay({
      meetingId: 'm', locale: 'en', endAt: '1:00', participants: people('a'),
      events: [{ at: '0:00', dur: 10, speaker: 'a', text: 'x' }, { at: '0:05', dur: 10, speaker: 'a', text: 'y' }],
    });
    expect(session.state.airtime.a.totalMs).toBe(15_000);
  });

  it('paces against wall clock without accumulating timer drift', async () => {
    const f = FixtureSchema.parse({ meetingId: 'm', locale: 'en', endAt: '3:00', participants: people('a'), events: [] });
    const t = performance.now();
    for await (const _ of new ReplaySource(f, 300).events()) void _;
    expect(performance.now() - t).toBeLessThan(1500); // 180s / 300 = 0.6s
  });
});

describe('engine', () => {
  it('records marks so rules can dedupe per item', () => {
    const e = new PolicyEngine();
    const c: Candidate = { key: 'k', marks: ['x'], type: 'missing_owner', priority: 2, message: '', ruleId: 'r' };
    e.decide([c], 0);
    expect(e.wasSent('x')).toBe(true);
  });
});

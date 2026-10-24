import { describe, expect, it } from 'vitest';
import { mmss, replayFile } from '../src/replay.js';
import type { Nudge } from '../src/policy/types.js';

const timeline = (ns: Nudge[]) => ns.map((n) => `${mmss(n.atMs)} ${n.ruleId}`);
const nonP1InWindow = (ns: Nudge[], at: number) => ns.filter((n) => n.priority !== 1 && n.atMs <= at && at - n.atMs < 5 * 60_000).length;

describe('workshop fixture (Design Sprint lite, ja)', async () => {
  const { nudges, session } = await replayFile('fixtures/transcripts/workshop-design-sprint.ja.json');

  it('produces the expected nudge timeline', () => {
    expect(timeline(nudges)).toEqual([
      '00:00 step_transition',
      '04:00 timebox_warning',
      '05:00 step_transition',
      '10:00 timebox_warning',
      '10:48 silent_participant',
      '12:00 step_transition',
      '18:00 timebox_warning',
      '20:00 step_transition',
      '27:00 timebox_warning',
      '28:00 step_transition', // vote: no warnings configured
      '33:00 step_transition',
      '37:00 timebox_warning',
      '38:00 timebox_exceeded', // decide is manual and overruns until 42:30
      '42:30 step_transition',
      '50:30 timebox_warning',
      '52:30 step_transition',
    ]);
  });

  it('auto-advances on_timebox steps and waits for manual ones', () => {
    expect(nudges.filter((n) => n.ruleId === 'step_transition').map((n) => n.id)).toEqual(
      ['goal', 'map', 'hmw', 'crazy8', 'vote', 'decide', 'storyboard', 'recap'].map((s) => `step_transition:${s}`),
    );
    expect(session.state.workshopFinished).toBe(true);
  });

  it('silent_participant: fires for 田中 ~10min after they last spoke, never during silent work', () => {
    const silent = nudges.filter((n) => n.ruleId === 'silent_participant');
    expect(silent).toHaveLength(1);
    expect(silent[0].message).toContain('田中');
    expect(nudges.some((n) => n.ruleId === 'silent_participant' && n.atMs >= 20 * 60_000 && n.atMs < 29 * 60_000)).toBe(false);
  });

  it('never exceeds 2 non-priority-1 nudges per 5 minutes and messages are in ja', () => {
    for (const n of nudges) expect(nonP1InWindow(nudges, n.atMs)).toBeLessThanOrEqual(2);
    for (const n of nudges) expect(n.message).toMatch(/[ぁ-んァ-ン]/);
  });
});

describe('meeting fixture (weekly, zh)', async () => {
  const { nudges, session } = await replayFile('fixtures/transcripts/meeting-weekly.zh.json');

  it('has no workshop nudges, one silent_participant for 王 at ~11min', () => {
    expect(session.state.mode).toBe('meeting');
    expect(timeline(nudges)).toEqual(['11:05 silent_participant']);
    expect(nudges[0].message).toContain('王');
  });

  it('tracks airtime', () => {
    expect(session.state.airtime.p3.totalMs).toBeGreaterThan(session.state.airtime.p4.totalMs);
    expect(session.state.airtime.p4.lastSpokeAtMs).toBe(65_000);
  });
});

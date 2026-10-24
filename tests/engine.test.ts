import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicyEngine } from '../src/policy/engine.js';
import type { Candidate } from '../src/policy/types.js';

const c = (key: string, type: Candidate['type'], priority: Candidate['priority']): Candidate => ({ key, type, priority, message: key, ruleId: key });
const MIN = 60_000;

describe('PolicyEngine', () => {
  it('sends each key once', () => {
    const e = new PolicyEngine();
    expect(e.decide([c('a', 'step_transition', 1)], 0)).toHaveLength(1);
    expect(e.decide([c('a', 'step_transition', 1)], 10 * MIN)).toHaveLength(0);
  });

  it('applies per-type cooldown (default 3 min)', () => {
    const e = new PolicyEngine();
    expect(e.decide([c('s1', 'silent_participant', 3)], 0)).toHaveLength(1);
    expect(e.decide([c('s2', 'silent_participant', 3)], 2 * MIN)).toHaveLength(0);
    expect(e.decide([c('s2', 'silent_participant', 3)], 3 * MIN)).toHaveLength(1);
  });

  it('caps non-p1 nudges at 2 per 5 min, highest priority first; dropped candidates may retry later', () => {
    const e = new PolicyEngine({ ...DEFAULT_POLICY, cooldownMs: {}, defaultCooldownMs: 0 });
    const sent = e.decide([c('low', 'silent_participant', 3), c('mid1', 'timebox', 2), c('mid2', 'missing_owner', 2)], 0);
    expect(sent.map((n) => n.id)).toEqual(['mid1', 'mid2']);
    expect(e.decide([c('low', 'silent_participant', 3)], 4 * MIN)).toHaveLength(0);
    expect(e.decide([c('low', 'silent_participant', 3)], 5 * MIN)).toHaveLength(1);
  });

  it('priority 1 is not blocked by the rate limit but counts toward it', () => {
    const e = new PolicyEngine({ ...DEFAULT_POLICY, cooldownMs: {}, defaultCooldownMs: 0 });
    e.decide([c('a', 'timebox', 2), c('b', 'missing_owner', 2)], 0);
    expect(e.decide([c('t', 'step_transition', 1)], MIN)).toHaveLength(1); // window already full
    const e2 = new PolicyEngine({ ...DEFAULT_POLICY, cooldownMs: {}, defaultCooldownMs: 0 });
    e2.decide([c('a', 'timebox', 2), c('t', 'step_transition', 1)], 0);
    expect(e2.decide([c('x', 'recap', 2)], MIN)).toHaveLength(0); // a + t fill the window
  });
});

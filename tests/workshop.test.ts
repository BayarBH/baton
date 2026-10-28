import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkshop, WorkshopScriptSchema } from '../src/workshop/schema.js';

describe('workshop schema', () => {
  it('all fixture scripts validate', () => {
    const dir = join('fixtures', 'workshops');
    for (const f of readdirSync(dir)) expect(() => loadWorkshop(join(dir, f))).not.toThrow();
  });

  it('rejects duplicate step ids and bad transitions', () => {
    const step = { id: 'a', name: 'A', timeboxMin: 1, goal: 'g', transition: 'manual' };
    expect(WorkshopScriptSchema.safeParse({ id: 'x', title: 't', locale: 'en', steps: [step, step] }).success).toBe(false);
    expect(WorkshopScriptSchema.safeParse({ id: 'x', title: 't', locale: 'en', steps: [{ ...step, transition: 'later' }] }).success).toBe(false);
  });
});

describe('Chinese workshop script (default language)', () => {
  it('loads and announces steps in Chinese', async () => {
    const { Session } = await import('../src/session.js');
    const workshop = loadWorkshop('fixtures/workshops/design-sprint-lite.zh.json');
    const nudges = await new Session({ meetingId: 'm', locale: 'zh', workshop }).handle({ type: 'tick', atMs: 0 });
    expect(nudges[0]?.message).toContain('长期目标');
    expect(workshop.locale).toBe('zh');
  });
});

import { describe, expect, it } from 'vitest';
import type { AnalyzeInput, Analysis, LlmProvider } from '../src/llm/provider.js';
import { mmss, replayFile } from '../src/replay.js';

/** Scripted stand-in for Claude on the weekly-meeting fixture: keyword rules, sticky topic start. */
class FakeMeetingLlm implements LlmProvider {
  calls: AnalyzeInput[] = [];
  private topicSince?: number;
  async analyze(input: AnalyzeInput): Promise<Analysis> {
    this.calls.push(input);
    const has = (s: string) => input.utterances.find((u) => u.text.includes(s));
    const decided = has('就这样定');
    this.topicSince ??= has('发布日期')?.i;
    const owner = has('我来写') ? '张' : null;
    const known = input.known.actionItems[0];
    return {
      decisions: decided ? [{ id: null, text: '下周五发布' }] : [],
      // Rewords the known item on purpose: identity must come from the id, not the text.
      actionItems: known ? [{ id: known.id, text: `${known.text}!`, owner }] : has('release note') ? [{ id: null, text: '写 release note', owner }] : [],
      openQuestions: [],
      unresolvedTopic: this.topicSince !== undefined && !decided
        ? { topic: '发布日期', sinceUtterance: input.known.unresolvedTopic ? -1 : this.topicSince, continuesKnown: !!input.known.unresolvedTopic }
        : null,
    };
  }
}

const MEETING = 'fixtures/transcripts/meeting-weekly.zh.json';

describe('LLM tracking on the weekly meeting (fake provider)', async () => {
  const llm = new FakeMeetingLlm();
  const { nudges, session } = await replayFile(MEETING, { session: { llm } });
  const at = (rule: string) => nudges.filter((n) => n.ruleId === rule).map((n) => mmss(n.atMs));

  it('throttles LLM calls to about one per minute, never per utterance', () => {
    expect(session.llm?.calls).toBe(llm.calls.length);
    expect(llm.calls.length).toBeLessThanOrEqual(26); // 25 min meeting + final flush
    expect(llm.calls.length).toBeLessThan(31); // < number of utterances
  });

  it('missing_owner fires ~1 min after the ownerless action item is extracted', () => {
    expect(at('missing_owner')).toEqual(['10:00']); // "release note 谁来写" ends 8:20 → extracted at 9:00 → grace 1 min
  });

  it('missing_decision fires ~8 min after the release-date debate started', () => {
    expect(at('missing_decision')).toEqual(['10:50']); // debate starts 2:50
    expect(nudges.find((n) => n.ruleId === 'missing_decision')?.message).toContain('发布日期');
  });

  it('recap at the end lists the ownerless action item', () => {
    const r = nudges.filter((n) => n.ruleId === 'recap');
    expect(r).toHaveLength(1);
    expect(r[0].message).toMatch(/写 release note!*（负责人待定）/);
  });

  it('still respects the global rate limit for non-p1 nudges', () => {
    for (const n of nudges) {
      const inWindow = nudges.filter((m) => m.priority !== 1 && m.atMs <= n.atMs && n.atMs - m.atMs < 5 * 60_000);
      expect(inWindow.length).toBeLessThanOrEqual(2);
    }
  });

  it('only sends the recent window of transcript to the LLM', () => {
    const last = llm.calls.at(-1)!;
    expect(Math.min(...last.utterances.map((u) => u.atMs))).toBeGreaterThan(10 * 60_000);
  });
});

describe('LLM failures do not break the session', async () => {
  const failing: LlmProvider = { analyze: async () => { throw new Error('boom'); } };
  it('keeps running rules when every analyze call throws', async () => {
    const { nudges } = await replayFile(MEETING, { session: { llm: failing } });
    expect(nudges.map((n) => n.ruleId)).toEqual(['silent_participant']);
  });
});

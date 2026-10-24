import type { TranscriptEvent } from '../ingest/types.js';
import type { LlmProvider } from '../llm/provider.js';
import type { Locale } from '../workshop/schema.js';
import type { MeetingState } from './meeting-state.js';

export interface LlmTrackerConfig {
  intervalMs: number; // run at most this often...
  maxPending: number; // ...or sooner once this many new utterances queue up
  windowMs: number; // how much recent transcript the LLM sees
}

export const DEFAULT_LLM_TRACKER: LlmTrackerConfig = { intervalMs: 60_000, maxPending: 20, windowMs: 10 * 60_000 };

/**
 * Batched LLM extraction of decisions / action items / open questions / stalled topic.
 * Transcript text stays in memory only and is never logged.
 */
export class LlmTracker {
  private utterances: { i: number; atMs: number; endMs: number; speaker: string; text: string }[] = [];
  private pending = 0;
  private lastRunMs = 0;
  calls = 0;

  constructor(
    private readonly provider: LlmProvider,
    private readonly locale: Locale,
    private readonly cfg: LlmTrackerConfig = DEFAULT_LLM_TRACKER,
  ) {}

  add(ev: TranscriptEvent): void {
    this.utterances.push({ i: this.utterances.length, atMs: ev.startMs, endMs: ev.endMs, speaker: ev.speakerName, text: ev.text });
    this.pending++;
  }

  due(nowMs: number): boolean {
    return this.pending > 0 && (this.pending >= this.cfg.maxPending || nowMs - this.lastRunMs >= this.cfg.intervalMs);
  }

  /**
   * Awaited inline, so replay is deterministic.
   * ponytail: blocks the event loop's clock for one LLM round-trip per minute; move to background if live timebox nudges lag.
   */
  async update(state: MeetingState, nowMs: number): Promise<void> {
    if (!this.pending) return;
    this.pending = 0;
    this.lastRunMs = nowMs;
    this.calls++;
    let a;
    try {
      a = await this.provider.analyze({
        locale: this.locale,
        utterances: this.utterances.filter((u) => nowMs - u.endMs <= this.cfg.windowMs).map(({ i, atMs, speaker, text }) => ({ i, atMs, speaker, text })),
        known: {
          decisions: state.decisions.map(({ text }) => ({ text })),
          actionItems: state.actionItems.map(({ text, owner }) => ({ text, owner: owner ?? null })),
          openQuestions: state.openQuestions.map(({ text }) => ({ text })),
        },
      });
    } catch (err) {
      console.warn(`[llm-tracker] analyze failed at ${nowMs}ms: ${(err as Error).message}`); // keep state, retry next window
      return;
    }
    if (!a) return;
    const since = (text: string, prev: { text: string; atMs: number }[]) => prev.find((p) => p.text === text)?.atMs ?? nowMs;
    state.decisions = a.decisions.map((d) => ({ text: d.text, atMs: since(d.text, state.decisions) }));
    state.actionItems = a.actionItems.map((x) => ({ text: x.text, owner: x.owner ?? undefined, atMs: since(x.text, state.actionItems) }));
    state.openQuestions = a.openQuestions.map((q) => ({ text: q.text, atMs: since(q.text, state.openQuestions) }));
    const start = a.unresolvedTopic && this.utterances[a.unresolvedTopic.sinceUtterance]?.atMs;
    state.unresolvedTopic = a.unresolvedTopic ? { topic: a.unresolvedTopic.topic, sinceMs: start ?? state.unresolvedTopic?.sinceMs ?? nowMs } : undefined;
  }
}

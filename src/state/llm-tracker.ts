import type { TranscriptEvent } from '../ingest/types.js';
import { LlmConfigError, type Analysis, type LlmProvider } from '../llm/provider.js';
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
 * Items keep a stable id across calls so dedupe and "since when" survive the LLM rewording them.
 * Transcript text stays in memory only and is never logged.
 */
export class LlmTracker {
  private utterances: { i: number; atMs: number; endMs: number; speaker: string; text: string }[] = [];
  private pending = 0;
  private lastRunMs = 0;
  private nextId = 0;
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

  /** Awaited inline by replays (deterministic); live sessions run it in the background (Session.llmInBackground). */
  async update(state: MeetingState, nowMs: number): Promise<void> {
    if (!this.pending) return;
    const batch = this.pending;
    this.pending = 0;
    this.lastRunMs = nowMs;
    this.calls++;
    let a: Analysis | null;
    try {
      a = await this.provider.analyze({
        locale: this.locale,
        utterances: this.utterances.filter((u) => nowMs - u.endMs <= this.cfg.windowMs).map(({ i, atMs, speaker, text }) => ({ i, atMs, speaker, text })),
        known: {
          decisions: state.decisions.map(({ id, text }) => ({ id, text })),
          actionItems: state.actionItems.map(({ id, text, owner }) => ({ id, text, owner: owner ?? null })),
          openQuestions: state.openQuestions.map(({ id, text }) => ({ id, text })),
          unresolvedTopic: state.unresolvedTopic?.topic ?? null,
        },
      });
    } catch (err) {
      if (err instanceof LlmConfigError) throw err;
      this.pending += batch; // retry these utterances next window (and at the final flush)
      console.warn(`[llm-tracker] analyze failed at ${nowMs}ms (${(err as Error).name}); will retry`); // no message: it may echo transcript
      return;
    }
    if (!a) return;
    const merge = <T extends { id: string | null }>(items: T[], prev: { id: string; atMs: number }[]) =>
      items.map(({ id, ...rest }) => {
        const p = prev.find((x) => x.id === id);
        return { ...rest, id: p?.id ?? `i${this.nextId++}`, atMs: p?.atMs ?? nowMs };
      });
    state.decisions = merge(a.decisions, state.decisions);
    state.actionItems = merge(a.actionItems, state.actionItems).map((x) => ({ ...x, owner: x.owner ?? undefined }));
    state.openQuestions = merge(a.openQuestions, state.openQuestions);

    const t = a.unresolvedTopic;
    const prev = state.unresolvedTopic;
    if (!t) state.unresolvedTopic = undefined;
    else if (prev && t.continuesKnown) state.unresolvedTopic = { ...prev, topic: t.topic }; // same debate: keep its start
    else {
      const i = t.sinceUtterance;
      const start = Number.isInteger(i) && i >= 0 && i < this.utterances.length ? this.utterances[i].atMs : nowMs;
      state.unresolvedTopic = { topic: t.topic, sinceMs: start };
    }
  }
}

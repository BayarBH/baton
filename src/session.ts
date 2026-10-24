import type { TranscriptSource } from './ingest/source.js';
import type { SourceEvent } from './ingest/types.js';
import { PolicyEngine, type PolicyConfig } from './policy/engine.js';
import { missingDecision } from './policy/rules/missing-decision.js';
import { missingOwner } from './policy/rules/missing-owner.js';
import { recap } from './policy/rules/recap.js';
import { silentParticipant } from './policy/rules/silent-participant.js';
import { stepTransition } from './policy/rules/step-transition.js';
import { timeboxExceeded } from './policy/rules/timebox-exceeded.js';
import { timeboxWarning } from './policy/rules/timebox-warning.js';
import type { Nudge, Rule, RuleConfig } from './policy/types.js';
import type { LlmProvider } from './llm/provider.js';
import { LlmTracker, type LlmTrackerConfig } from './state/llm-tracker.js';
import { createState, type MeetingState } from './state/meeting-state.js';
import { track } from './state/tracker.js';
import { WorkshopRunner } from './workshop/runner.js';
import type { Locale, WorkshopScript } from './workshop/schema.js';

export const DEFAULT_RULES: RuleConfig = {
  silentAfterMs: 10 * 60_000,
  activeDiscussionMs: 2 * 60_000,
  exceededRepeatMs: 5 * 60_000,
  missingDecisionAfterMs: 8 * 60_000,
  missingOwnerGraceMs: 60_000,
};

const RULES: Rule[] = [stepTransition, timeboxWarning, timeboxExceeded, silentParticipant, missingDecision, missingOwner, recap];

export interface SessionConfig {
  meetingId: string;
  locale: Locale;
  workshop?: WorkshopScript;
  rules?: Partial<RuleConfig>;
  policy?: PolicyConfig;
  /** Omit to run rules-only (no decisions / action items / recap). */
  llm?: LlmProvider;
  llmTracker?: LlmTrackerConfig;
}

export class Session {
  readonly state: MeetingState;
  private readonly runner?: WorkshopRunner;
  private readonly engine: PolicyEngine;
  private readonly rules: RuleConfig;
  private readonly locale: Locale;
  readonly llm?: LlmTracker;

  constructor(cfg: SessionConfig) {
    this.state = createState(cfg.meetingId, cfg.workshop ? 'workshop' : 'meeting');
    this.runner = cfg.workshop && new WorkshopRunner(cfg.workshop);
    this.runner?.start(this.state, 0);
    this.engine = new PolicyEngine(cfg.policy);
    this.rules = { ...DEFAULT_RULES, ...cfg.rules };
    this.locale = cfg.workshop?.locale ?? cfg.locale;
    this.llm = cfg.llm && new LlmTracker(cfg.llm, this.locale, cfg.llmTracker);
  }

  async handle(ev: SourceEvent): Promise<Nudge[]> {
    track(this.state, ev);
    if (ev.type === 'transcript') this.llm?.add(ev);
    if (ev.type === 'control' && ev.action === 'next_step') this.runner?.advance(this.state, ev.atMs);
    // Rules run on the clock (and once at the end), so output is independent of event batching.
    if (ev.type !== 'tick' && ev.type !== 'end') return [];
    this.runner?.tick(this.state, ev.atMs);
    if (this.llm && (ev.type === 'end' || this.llm.due(ev.atMs))) await this.llm.update(this.state, ev.atMs);
    const ctx = {
      state: this.state,
      nowMs: ev.atMs,
      locale: this.locale,
      config: this.rules,
      step: this.runner?.current(this.state),
      nextStep: this.runner?.next(this.state),
    };
    return this.engine.decide(RULES.flatMap((r) => r(ctx)), ev.atMs);
  }
}

export async function run(source: TranscriptSource, session: Session, onNudge: (n: Nudge) => void = () => {}): Promise<Nudge[]> {
  const all: Nudge[] = [];
  for await (const ev of source.events()) {
    for (const n of await session.handle(ev)) {
      all.push(n);
      onNudge(n);
    }
  }
  return all;
}

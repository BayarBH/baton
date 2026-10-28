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
  /**
   * Live meetings: run periodic LLM extraction in the background so a slow call never delays timebox nudges or "next step".
   * The end of the meeting and the start of the last workshop step still wait for a fresh extraction (the recap needs it).
   * Off by default so replays and tests stay deterministic.
   */
  llmInBackground?: boolean;
}

/** What the sidebar shows besides nudges. Times are meeting time (ms since start). */
export interface SessionStatus {
  locale: Locale;
  mode: MeetingState['mode'];
  elapsedMs: number;
  ended: boolean;
  step?: { name: string; goal: string; script?: string; index: number; count: number; startedAtMs: number; timeboxMs: number };
}

export class Session {
  readonly state: MeetingState;
  private readonly runner?: WorkshopRunner;
  private readonly engine: PolicyEngine;
  private readonly rules: RuleConfig;
  private readonly locale: Locale;
  readonly llm?: LlmTracker;
  private lastStepSeen?: string;
  private readonly llmInBackground: boolean;
  private inflight?: Promise<void>;
  private llmError?: unknown;

  constructor(cfg: SessionConfig) {
    this.state = createState(cfg.meetingId, cfg.workshop ? 'workshop' : 'meeting');
    this.runner = cfg.workshop && new WorkshopRunner(cfg.workshop);
    this.runner?.start(this.state, 0);
    this.engine = new PolicyEngine(cfg.policy);
    this.rules = { ...DEFAULT_RULES, ...cfg.rules };
    this.locale = cfg.workshop?.locale ?? cfg.locale;
    this.llm = cfg.llm && new LlmTracker(cfg.llm, this.locale, cfg.llmTracker);
    this.llmInBackground = !!cfg.llmInBackground;
  }

  async handle(ev: SourceEvent): Promise<Nudge[]> {
    track(this.state, ev);
    if (ev.type === 'transcript') this.llm?.add(ev);
    if (ev.type === 'control' && ev.action === 'next_step') this.runner?.advance(this.state, ev.atMs);
    // Rules run on the clock (and once at the end), so output is independent of event batching.
    if (ev.type !== 'tick' && ev.type !== 'end') return [];
    this.runner?.tick(this.state, ev.atMs);
    // Force a fresh extraction for the final recap: at the end, and when the last workshop step begins.
    const enteredLastStep = this.state.currentStepId !== this.lastStepSeen && !!this.runner?.current(this.state) && !this.runner.next(this.state);
    this.lastStepSeen = this.state.currentStepId;
    if (this.llm) await this.updateLlm(ev.type === 'end' || enteredLastStep, ev.atMs);
    const ctx = {
      state: this.state,
      nowMs: ev.atMs,
      locale: this.locale,
      config: this.rules,
      step: this.state.ended ? undefined : this.runner?.current(this.state),
      nextStep: this.state.ended ? undefined : this.runner?.next(this.state),
      wasSent: (k: string) => this.engine.wasSent(k),
    };
    return this.engine.decide(RULES.flatMap((r) => r(ctx)), ev.atMs);
  }

  private async updateLlm(force: boolean, nowMs: number): Promise<void> {
    const llm = this.llm!;
    if (this.llmError) throw this.llmError; // a fatal error (LlmConfigError) from a background call
    if (force || (!this.llmInBackground && llm.due(nowMs))) {
      await this.inflight; // never two extractions at once
      if (this.llmError) throw this.llmError;
      await llm.update(this.state, nowMs);
    } else if (this.llmInBackground && !this.inflight && llm.due(nowMs)) {
      this.inflight = llm
        .update(this.state, nowMs)
        .catch((err) => void (this.llmError = err))
        .finally(() => (this.inflight = undefined));
    }
  }

  status(): SessionStatus {
    const { state, runner } = this;
    const step = state.ended ? undefined : runner?.current(state);
    return {
      locale: this.locale,
      mode: state.mode,
      elapsedMs: state.elapsedMs,
      ended: !!state.ended,
      step: step && {
        name: step.name,
        goal: step.goal,
        script: step.facilitatorScript,
        index: runner!.script.steps.indexOf(step),
        count: runner!.script.steps.length,
        startedAtMs: state.stepStartedAtMs ?? 0,
        timeboxMs: step.timeboxMin * 60_000,
      },
    };
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

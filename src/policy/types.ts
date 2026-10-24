import type { MeetingState } from '../state/meeting-state.js';
import type { Locale, WorkshopStep } from '../workshop/schema.js';

export type NudgeType = 'timebox' | 'step_transition' | 'silent_participant' | 'missing_decision' | 'missing_owner' | 'recap';

export interface Nudge {
  id: string;
  atMs: number;
  type: NudgeType;
  priority: 1 | 2 | 3; // 1 = highest
  message: string;
  ruleId: string;
}

/** A rule's proposal. `key` identifies one logical occurrence; the engine sends each key at most once. */
export type Candidate = Omit<Nudge, 'id' | 'atMs'> & { key: string };

export interface RuleConfig {
  silentAfterMs: number;
  activeDiscussionMs: number;
  exceededRepeatMs: number;
}

export interface RuleContext {
  state: MeetingState;
  nowMs: number;
  locale: Locale;
  config: RuleConfig;
  step?: WorkshopStep;
  nextStep?: WorkshopStep;
}

export type Rule = (ctx: RuleContext) => Candidate[];

export const fmtMin = (ms: number) => Math.max(1, Math.round(ms / 60_000));

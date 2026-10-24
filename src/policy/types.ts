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
export type Candidate = Omit<Nudge, 'id' | 'atMs'> & {
  key: string;
  /** Extra keys recorded as sent with this nudge (e.g. one per person), readable by rules via `wasSent`. */
  marks?: string[];
};

export interface RuleConfig {
  silentAfterMs: number;
  activeDiscussionMs: number;
  exceededRepeatMs: number;
  missingDecisionAfterMs: number;
  missingOwnerGraceMs: number;
}

export interface RuleContext {
  state: MeetingState;
  nowMs: number;
  locale: Locale;
  config: RuleConfig;
  step?: WorkshopStep;
  nextStep?: WorkshopStep;
  wasSent: (key: string) => boolean;
}

export type Rule = (ctx: RuleContext) => Candidate[];

/** Quote a user-facing item: 「」 for ja/zh, "" for en. */
export const quote = (locale: Locale, s: string) => (locale === 'en' ? `"${s}"` : `「${s}」`);

export const fmtMin = (ms: number) => Math.max(1, Math.round(ms / 60_000));

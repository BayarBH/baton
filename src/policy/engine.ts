import type { Candidate, Nudge, NudgeType } from './types.js';

export interface PolicyConfig {
  defaultCooldownMs: number;
  cooldownMs: Partial<Record<NudgeType, number>>;
  windowMs: number;
  maxPerWindow: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  defaultCooldownMs: 3 * 60_000,
  // Transitions are structural (once per step); timebox reminders are spaced by the script's thresholds.
  cooldownMs: { step_transition: 0, timebox: 60_000 },
  windowMs: 5 * 60_000,
  maxPerWindow: 2,
};

/**
 * Cooldown per type, global rate limit, priority ordering, key dedupe.
 * Priority-1 nudges (step transitions, timebox exceeded) skip the rate limit but still count toward it:
 * otherwise a silent-participant hint could hide "time's up". Everything else is dropped when the window is full.
 * A dropped candidate is not remembered — its rule re-proposes it on later ticks while still relevant.
 */
export class PolicyEngine {
  private sentKeys = new Set<string>();
  private lastByType = new Map<NudgeType, number>();
  private sentAt: number[] = [];

  constructor(private readonly cfg: PolicyConfig = DEFAULT_POLICY) {}

  decide(candidates: Candidate[], nowMs: number): Nudge[] {
    const out: Nudge[] = [];
    for (const c of [...candidates].sort((a, b) => a.priority - b.priority)) {
      if (this.sentKeys.has(c.key)) continue;
      const last = this.lastByType.get(c.type);
      if (last !== undefined && nowMs - last < (this.cfg.cooldownMs[c.type] ?? this.cfg.defaultCooldownMs)) continue;
      this.sentAt = this.sentAt.filter((t) => nowMs - t < this.cfg.windowMs);
      if (c.priority !== 1 && this.sentAt.length >= this.cfg.maxPerWindow) continue;
      this.sentKeys.add(c.key);
      this.lastByType.set(c.type, nowMs);
      this.sentAt.push(nowMs);
      out.push({ id: c.key, atMs: nowMs, type: c.type, priority: c.priority, message: c.message, ruleId: c.ruleId });
    }
    return out;
  }
}

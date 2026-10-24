import type { Rule } from '../types.js';

/** Fires once per threshold, only while remaining time is between this threshold and the next smaller one. */
export const timeboxWarning: Rule = ({ step, state, nowMs, locale }) => {
  if (!step?.warnAtRemainingMin || state.stepStartedAtMs === undefined) return [];
  const remaining = state.stepStartedAtMs + step.timeboxMin * 60_000 - nowMs;
  if (remaining <= 0) return [];
  const ths = [...step.warnAtRemainingMin].sort((a, b) => b - a);
  const i = ths.findIndex((m, j) => remaining <= m * 60_000 && remaining > (ths[j + 1] ?? 0) * 60_000);
  if (i < 0) return [];
  const left = Math.ceil(remaining / 60_000);
  return [{
    key: `timebox_warning:${step.id}:${ths[i]}`,
    type: 'timebox',
    priority: 2,
    ruleId: 'timebox_warning',
    message: { ja: `「${step.name}」残り${left}分です`, zh: `「${step.name}」还剩 ${left} 分钟`, en: `"${step.name}": ${left} min left` }[locale],
  }];
};

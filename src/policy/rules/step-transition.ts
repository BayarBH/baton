import type { Rule } from '../types.js';

export const stepTransition: Rule = ({ step, locale }) => {
  if (!step) return [];
  const m = step.timeboxMin;
  const head = { ja: `ステップ「${step.name}」開始（${m}分）`, zh: `开始「${step.name}」（${m} 分钟）`, en: `Now: "${step.name}" (${m} min)` }[locale];
  return [{
    key: `step_transition:${step.id}`,
    type: 'step_transition',
    priority: 1,
    ruleId: 'step_transition',
    message: step.facilitatorScript ? `${head} — ${step.facilitatorScript}` : head,
  }];
};

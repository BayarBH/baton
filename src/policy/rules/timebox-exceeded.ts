import { fmtMin, type Rule } from '../types.js';

/** Steps that don't auto-advance: remind when over time, again every `exceededRepeatMs`. */
export const timeboxExceeded: Rule = ({ step, nextStep, state, nowMs, locale, config }) => {
  if (!step || state.stepStartedAtMs === undefined) return [];
  const over = nowMs - (state.stepStartedAtMs + step.timeboxMin * 60_000);
  if (over < 0) return [];
  const n = fmtMin(over);
  const next = nextStep
    ? { ja: `「${nextStep.name}」に進みましょうか？`, zh: `是否进入「${nextStep.name}」？`, en: `Move on to "${nextStep.name}"?` }[locale]
    : { ja: 'そろそろ締めましょうか？', zh: '是否准备收尾？', en: 'Time to wrap up?' }[locale];
  const head = over < 60_000
    ? { ja: `「${step.name}」の時間になりました。`, zh: `「${step.name}」时间到了。`, en: `"${step.name}" is out of time.` }[locale]
    : { ja: `「${step.name}」が${n}分超過しています。`, zh: `「${step.name}」已超时 ${n} 分钟。`, en: `"${step.name}" is ${n} min over.` }[locale];
  return [{
    key: `timebox_exceeded:${step.id}:${Math.floor(over / config.exceededRepeatMs)}`,
    type: 'timebox',
    priority: 1,
    ruleId: 'timebox_exceeded',
    message: `${head}${locale === 'en' ? ' ' : ''}${next}`,
  }];
};

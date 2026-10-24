import { fmtMin, quote, type Rule } from '../types.js';

/** LLM flagged a topic debated without conclusion; nudge once it has dragged on long enough. */
export const missingDecision: Rule = ({ state, nowMs, locale, config }) => {
  const t = state.unresolvedTopic;
  if (!t || state.ended || nowMs - t.sinceMs < config.missingDecisionAfterMs) return [];
  const n = fmtMin(nowMs - t.sinceMs);
  return [{
    key: `missing_decision:${t.sinceMs}`,
    type: 'missing_decision',
    priority: 2,
    ruleId: 'missing_decision',
    message: {
      ja: `${quote(locale, t.topic)}の議論が${n}分続いていますが、まだ結論が出ていません。決めるか、保留にして次へ進むか確認しましょう。`,
      zh: `${quote(locale, t.topic)}已经讨论了 ${n} 分钟，还没有结论。可以确认一下：现在拍板，还是先搁置？`,
      en: `${quote(locale, t.topic)} has been debated for ${n} min with no decision. Decide now, or park it and move on?`,
    }[locale],
  }];
};

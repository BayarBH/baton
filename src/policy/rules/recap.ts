import type { Rule } from '../types.js';

/** Once, when the last workshop step starts or the meeting ends: decisions, action items, open questions. */
export const recap: Rule = ({ state, step, nextStep, locale }) => {
  const inLastStep = !!step && !nextStep;
  if (!inLastStep && !state.ended) return [];
  const { decisions, actionItems, openQuestions } = state;
  if (!decisions.length && !actionItems.length && !openQuestions.length) return [];
  const L = {
    ja: { title: 'まとめ', d: '決定事項', a: 'アクション', q: '未解決の問い', none: '担当未定' },
    zh: { title: '会议小结', d: '决定', a: '待办', q: '未决问题', none: '负责人待定' },
    en: { title: 'Recap', d: 'Decisions', a: 'Action items', q: 'Open questions', none: 'no owner' },
  }[locale];
  const section = (head: string, lines: string[]) => (lines.length ? [`${head}:`, ...lines.map((l) => `- ${l}`)] : []);
  return [{
    key: 'recap',
    type: 'recap',
    priority: 1,
    ruleId: 'recap',
    message: [
      `${L.title}`,
      ...section(L.d, decisions.map((d) => d.text)),
      ...section(L.a, actionItems.map((a) => `${a.text}（${a.owner ?? L.none}）`)),
      ...section(L.q, openQuestions.map((q) => q.text)),
    ].join('\n'),
  }];
};

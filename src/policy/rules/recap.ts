import type { Rule } from '../types.js';

/**
 * A recap when the last workshop step starts (so people can confirm it), and a final one at the end
 * if anything changed since — e.g. owners agreed during the wrap-up.
 */
export const recap: Rule = ({ state, step, nextStep, locale, wasSent }) => {
  const inLastStep = !!step && !nextStep;
  if (!inLastStep && !state.ended) return [];
  const { decisions, actionItems, openQuestions } = state;
  if (!decisions.length && !actionItems.length && !openQuestions.length) return [];
  const L = {
    ja: { title: 'まとめ', d: '決定事項', a: 'アクション', q: '未解決の問い', none: '担当未定', colon: '：', owner: (o: string) => `（${o}）` },
    zh: { title: '会议小结', d: '决定', a: '待办', q: '未决问题', none: '负责人待定', colon: '：', owner: (o: string) => `（${o}）` },
    en: { title: 'Recap', d: 'Decisions', a: 'Action items', q: 'Open questions', none: 'no owner', colon: ':', owner: (o: string) => ` (${o})` },
  }[locale];
  const section = (head: string, lines: string[]) => (lines.length ? [`${head}${L.colon}`, ...lines.map((l) => `- ${l}`)] : []);
  const message = [
    L.title,
    ...section(L.d, decisions.map((d) => d.text)),
    ...section(L.a, actionItems.map((a) => a.text + L.owner(a.owner ?? L.none))),
    ...section(L.q, openQuestions.map((q) => q.text)),
  ].join('\n');
  const content = `recap:${message}`;
  if (state.ended && wasSent(content)) return []; // final recap only if it would say something new
  return [{ key: state.ended ? 'recap:end' : 'recap:last_step', marks: [content], type: 'recap', priority: 1, ruleId: 'recap', message }];
};

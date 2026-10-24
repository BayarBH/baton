import type { Rule } from '../types.js';

/** Action items nobody has taken after a short grace period. Each item is nudged once. */
export const missingOwner: Rule = ({ state, nowMs, locale, config, wasSent }) => {
  const items = state.actionItems.filter((a) => !a.owner && nowMs - a.atMs >= config.missingOwnerGraceMs && !wasSent(`owner:${a.text}`));
  if (!items.length || state.ended) return [];
  const list = items.map((a) => `「${a.text}」`).join(locale === 'en' ? ', ' : '、');
  return [{
    key: `missing_owner:${items.map((a) => a.text).sort().join('|')}`,
    marks: items.map((a) => `owner:${a.text}`),
    type: 'missing_owner',
    priority: 2,
    ruleId: 'missing_owner',
    message: {
      ja: `${list} の担当者が決まっていません。誰が持ちますか？`,
      zh: `${list} 还没有负责人，谁来跟进？`,
      en: `No owner yet for ${list}. Who takes it?`,
    }[locale],
  }];
};

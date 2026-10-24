import type { Rule } from '../types.js';

/** Action items nobody has taken after a short grace period. */
export const missingOwner: Rule = ({ state, nowMs, locale, config }) => {
  const items = state.actionItems.filter((a) => !a.owner && nowMs - a.atMs >= config.missingOwnerGraceMs);
  if (!items.length || state.ended) return [];
  const list = items.map((a) => `「${a.text}」`).join(locale === 'en' ? ', ' : '、');
  return [{
    key: `missing_owner:${items.map((a) => a.text).sort().join('|')}`,
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

import { quote, type Rule } from '../types.js';

/** Action items nobody has taken after a short grace period. Each item is nudged once. */
export const missingOwner: Rule = ({ state, nowMs, locale, config, wasSent }) => {
  if (state.ended) return [];
  const items = state.actionItems.filter((a) => !a.owner && nowMs - a.atMs >= config.missingOwnerGraceMs && !wasSent(`owner:${a.id}`));
  if (!items.length) return [];
  const list = items.map((a) => quote(locale, a.text)).join(locale === 'en' ? ', ' : '、');
  return [{
    key: `missing_owner:${items.map((a) => a.id).join(',')}`,
    marks: items.map((a) => `owner:${a.id}`),
    type: 'missing_owner',
    priority: 2,
    ruleId: 'missing_owner',
    message: {
      ja: `${list} の担当者が決まっていません。誰が持ちますか？`,
      zh: `${list} 还没有负责人，谁来跟进？`,
      en: `No owner yet for ${list}. Who takes ${items.length > 1 ? 'them' : 'it'}?`,
    }[locale],
  }];
};

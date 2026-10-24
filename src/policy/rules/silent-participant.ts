import type { Rule } from '../types.js';

/** Present participants quiet for `silentAfterMs` while others are actively talking. One nudge names them all. */
export const silentParticipant: Rule = ({ state, step, nowMs, locale, config }) => {
  if (step?.silentWork || state.workshopFinished) return [];
  const present = Object.entries(state.participants).filter(([, p]) => p.leftAtMs === undefined && p.joinedAtMs <= nowMs);
  const since = (id: string) => Math.max(state.participants[id].joinedAtMs, state.airtime[id]?.lastSpokeAtMs ?? 0);
  const silent = present.filter(([id]) => nowMs - since(id) >= config.silentAfterMs);
  const talking = present.some(([id]) => state.airtime[id] && nowMs - state.airtime[id].lastSpokeAtMs <= config.activeDiscussionMs);
  if (!silent.length || !talking || silent.length === present.length) return [];
  const names = silent.map(([, p]) => p.name);
  return [{
    key: `silent_participant:${silent.map(([id]) => `${id}@${since(id)}`).join(',')}`,
    type: 'silent_participant',
    priority: 3,
    ruleId: 'silent_participant',
    message: {
      ja: `${names.map((n) => `${n}さん`).join('、')}がしばらく発言していません。意見を聞いてみては？`,
      zh: `${names.join('、')} 已经有一段时间没发言了，可以邀请发表看法。`,
      en: `${names.join(', ')} ${names.length > 1 ? "haven't" : "hasn't"} spoken in a while — maybe invite their view?`,
    }[locale],
  }];
};

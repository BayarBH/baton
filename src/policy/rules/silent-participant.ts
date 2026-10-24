import type { Rule } from '../types.js';

const listEn = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);

/**
 * Present participants quiet for `silentAfterMs` while others are actively talking.
 * Each person is named once per silent stretch; heads-down (silentWork) time doesn't count as silence.
 */
export const silentParticipant: Rule = ({ state, step, nowMs, locale, config, wasSent }) => {
  if (step?.silentWork || state.workshopFinished || state.ended) return [];
  const present = Object.entries(state.participants).filter(([, p]) => p.leftAtMs === undefined && p.joinedAtMs <= nowMs);
  const since = (id: string) =>
    Math.max(state.participants[id].joinedAtMs, state.airtime[id]?.lastSpokeAtMs ?? 0, state.silentWorkEndedAtMs ?? 0);
  const silent = present.filter(([id]) => nowMs - since(id) >= config.silentAfterMs);
  const talking = present.some(([id]) => state.airtime[id] && nowMs - state.airtime[id].lastSpokeAtMs <= config.activeDiscussionMs);
  if (!silent.length || !talking || silent.length === present.length) return [];
  const fresh = silent.filter(([id]) => !wasSent(`silent:${id}@${since(id)}`));
  if (!fresh.length) return [];
  const names = fresh.map(([, p]) => p.name);
  const marks = fresh.map(([id]) => `silent:${id}@${since(id)}`);
  return [{
    key: `silent_participant:${marks.join(',')}`,
    marks,
    type: 'silent_participant',
    priority: 3,
    ruleId: 'silent_participant',
    message: {
      ja: `${names.map((n) => `${n}さん`).join('、')}がしばらく発言していません。意見を聞いてみては？`,
      zh: `${names.join('、')}已经有一段时间没发言了，可以主动问问看法。`,
      en: `${listEn(names)} ${names.length > 1 ? "haven't" : "hasn't"} spoken in a while — maybe invite their view?`,
    }[locale],
  }];
};

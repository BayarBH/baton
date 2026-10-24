import type { SourceEvent } from '../ingest/types.js';
import type { MeetingState } from './meeting-state.js';

/** Deterministic part of state tracking. LLM extraction lives in llm-tracker.ts. */
export function track(state: MeetingState, ev: SourceEvent): void {
  if (ev.type === 'tick' || ev.type === 'control' || ev.type === 'end') {
    if (ev.type === 'end') state.ended = true;
    state.elapsedMs = Math.max(state.elapsedMs, ev.atMs);
  } else if (ev.type === 'participant') {
    state.elapsedMs = Math.max(state.elapsedMs, ev.atMs);
    if (ev.kind === 'join') state.participants[ev.participantId] = { name: ev.name, joinedAtMs: ev.atMs };
    else if (state.participants[ev.participantId]) state.participants[ev.participantId].leftAtMs = ev.atMs;
  } else {
    state.elapsedMs = Math.max(state.elapsedMs, ev.endMs);
    state.participants[ev.speakerId] ??= { name: ev.speakerName, joinedAtMs: ev.startMs };
    const p = state.participants[ev.speakerId];
    if (p.leftAtMs !== undefined && ev.startMs > p.leftAtMs) delete p.leftAtMs; // speaking after leaving proves presence (reconnect race)
    const a = (state.airtime[ev.speakerId] ??= { totalMs: 0, lastSpokeAtMs: 0 });
    a.totalMs += Math.max(0, ev.endMs - Math.max(ev.startMs, a.lastSpokeAtMs)); // events arrive by endMs, so this unions overlaps
    a.lastSpokeAtMs = Math.max(a.lastSpokeAtMs, ev.endMs);
  }
}

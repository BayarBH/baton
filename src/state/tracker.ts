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
    const a = (state.airtime[ev.speakerId] ??= { totalMs: 0, lastSpokeAtMs: 0 });
    a.totalMs += Math.max(0, ev.endMs - ev.startMs);
    a.lastSpokeAtMs = Math.max(a.lastSpokeAtMs, ev.endMs);
  }
}

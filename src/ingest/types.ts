export type Lang = 'ja' | 'zh' | 'en' | 'mixed';

export interface TranscriptEvent {
  meetingId: string;
  speakerId: string;
  speakerName: string;
  text: string;
  startMs: number; // relative to meeting start
  endMs: number;
  lang?: Lang;
}

export interface ParticipantEvent {
  meetingId: string;
  participantId: string;
  name: string;
  kind: 'join' | 'leave';
  atMs: number;
}

/** Everything downstream consumes. `tick` advances the clock so time-based rules fire during silence. */
export type SourceEvent =
  | ({ type: 'transcript' } & TranscriptEvent)
  | ({ type: 'participant' } & ParticipantEvent)
  | { type: 'control'; action: 'next_step'; atMs: number }
  | { type: 'tick'; atMs: number }
  | { type: 'end'; atMs: number };

export function eventTime(ev: SourceEvent): number {
  return ev.type === 'transcript' ? ev.endMs : ev.atMs;
}

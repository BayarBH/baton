export interface MeetingState {
  meetingId: string;
  mode: 'workshop' | 'meeting';
  elapsedMs: number;
  currentStepId?: string;
  stepStartedAtMs?: number;
  workshopFinished?: boolean;
  participants: Record<string, { name: string; joinedAtMs: number; leftAtMs?: number }>;
  airtime: Record<string, { totalMs: number; lastSpokeAtMs: number }>;
  decisions: { text: string; atMs: number }[];
  actionItems: { text: string; owner?: string; atMs: number }[];
  openQuestions: { text: string; atMs: number }[];
  unresolvedTopic?: { topic: string; sinceMs: number };
  ended?: boolean;
  /** End of the most recent heads-down step; silence before it is not counted. */
  silentWorkEndedAtMs?: number;
}

export function createState(meetingId: string, mode: MeetingState['mode']): MeetingState {
  return { meetingId, mode, elapsedMs: 0, participants: {}, airtime: {}, decisions: [], actionItems: [], openQuestions: [] };
}

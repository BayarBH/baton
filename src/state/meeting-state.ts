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
}

export function createState(meetingId: string, mode: MeetingState['mode']): MeetingState {
  return { meetingId, mode, elapsedMs: 0, participants: {}, airtime: {}, decisions: [], actionItems: [], openQuestions: [] };
}

import type { TranscriptSource } from './source.js';
import type { SourceEvent } from './types.js';

/**
 * The slice of `@zoom/rtms`'s Client that Baton uses (signatures from the SDK's rtms.d.ts, v1.1.0).
 * Declared here because the native SDK only ships for linux-x64 / darwin-arm64: Windows dev and tests run without it.
 */
export interface RtmsClient {
  join(params: RtmsJoinParams): boolean;
  leave(): boolean;
  onTranscriptData(cb: (buffer: Buffer, size: number, timestamp: number, metadata: { userName: string; userId: number; startTs: number; endTs: number }) => void): boolean;
  onParticipantEvent(cb: (event: 'join' | 'leave', timestamp: number, participants: { userId: number; userName?: string }[]) => void): boolean;
  onLeave(cb: (reason: number) => void): boolean;
}

/** From the `meeting.rtms_started` webhook payload, plus credentials for the signature. */
export interface RtmsJoinParams {
  meeting_uuid: string;
  rtms_stream_id: string;
  server_urls: string;
  client?: string;
  secret?: string;
}

/**
 * Live RTMS stream as a TranscriptSource. Meeting time is measured on our own monotonic clock from join:
 * the SDK documents `startTs`/`endTs` as milliseconds but not their epoch, so only their difference (utterance length) is used.
 */
export class RtmsSource implements TranscriptSource {
  private readonly queue: SourceEvent[] = [];
  private wake?: () => void;
  private done = false;
  private readonly t0 = performance.now();

  constructor(
    private readonly client: RtmsClient,
    readonly meetingId: string,
    private readonly tickMs = 1000,
  ) {}

  private now(): number {
    return Math.round(performance.now() - this.t0);
  }

  /** Registers callbacks and joins. Participant events are subscribed after join: the SDK subscribes on the live session. */
  join(params: RtmsJoinParams): boolean {
    const meetingId = this.meetingId;
    this.client.onTranscriptData((buffer, _size, _ts, md) => {
      const text = buffer.toString('utf8').trim();
      if (!text) return;
      const endMs = this.now();
      const dur = md.endTs - md.startTs;
      const startMs = dur > 0 && dur < 120_000 ? Math.max(0, endMs - dur) : endMs;
      this.push({ type: 'transcript', meetingId, speakerId: String(md.userId), speakerName: md.userName, text, startMs, endMs });
    });
    this.client.onLeave(() => this.stop());
    const ok = this.client.join(params);
    if (!ok) {
      this.stop();
      return false;
    }
    this.client.onParticipantEvent((kind, _ts, participants) => {
      const atMs = this.now();
      for (const p of participants) this.push({ type: 'participant', meetingId, participantId: String(p.userId), name: p.userName ?? '', kind, atMs });
    });
    return true;
  }

  control(action: 'next_step'): void {
    this.push({ type: 'control', action, atMs: this.now() });
  }

  /** Ends the stream (meeting.rtms_stopped, onLeave, or shutdown). Idempotent. */
  stop(): void {
    this.push({ type: 'end', atMs: this.now() });
    this.done = true;
  }

  private push(ev: SourceEvent): void {
    if (this.done) return;
    this.queue.push(ev);
    this.wake?.();
  }

  async *events(): AsyncIterable<SourceEvent> {
    const timer = setInterval(() => this.push({ type: 'tick', atMs: this.now() }), this.tickMs);
    try {
      for (;;) {
        while (this.queue.length) {
          const ev = this.queue.shift()!;
          yield ev;
          if (ev.type === 'end') return;
        }
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    } finally {
      clearInterval(timer);
    }
  }
}

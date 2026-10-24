import type { SourceEvent } from './types.js';

/** Real RTMS and the offline replayer both implement this; nothing downstream knows which one it got. */
export interface TranscriptSource {
  events(): AsyncIterable<SourceEvent>;
}

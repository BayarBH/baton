import type { MeetingState } from '../state/meeting-state.js';
import type { WorkshopScript, WorkshopStep } from './schema.js';

export class WorkshopRunner {
  constructor(readonly script: WorkshopScript) {}

  current(state: MeetingState): WorkshopStep | undefined {
    return this.script.steps.find((s) => s.id === state.currentStepId);
  }

  next(state: MeetingState): WorkshopStep | undefined {
    const i = this.script.steps.findIndex((s) => s.id === state.currentStepId);
    return i < 0 ? undefined : this.script.steps[i + 1];
  }

  start(state: MeetingState, atMs: number): void {
    state.currentStepId = this.script.steps[0].id;
    state.stepStartedAtMs = atMs;
  }

  advance(state: MeetingState, atMs: number): void {
    if (state.workshopFinished) return;
    if (this.current(state)?.silentWork) state.silentWorkEndedAtMs = atMs;
    const next = this.next(state);
    state.currentStepId = next?.id;
    state.stepStartedAtMs = next ? atMs : undefined;
    state.workshopFinished = !next;
  }

  /**
   * Auto-advance steps whose timebox ran out. on_output is treated like manual (no output detection yet).
   * The last step never auto-finishes: it stays current so timebox_exceeded can prompt a wrap-up.
   */
  tick(state: MeetingState, nowMs: number): void {
    for (;;) {
      const step = this.current(state);
      if (!step || state.stepStartedAtMs === undefined) return;
      const endMs = state.stepStartedAtMs + step.timeboxMin * 60_000;
      if (nowMs < endMs || (step.transition !== 'on_timebox' && step.transition !== 'either') || !this.next(state)) return;
      this.advance(state, endMs);
    }
  }
}

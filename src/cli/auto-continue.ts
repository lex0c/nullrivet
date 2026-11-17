import type { AgentEndReason } from '../agent/events.ts';

// The check waits this long after the last poke, so events that arrive within this time of each
// other (a job becoming ready and ending, several jobs ending) are handled by one turn.
export const AUTO_CONTINUE_DELAY_MS = 250;
// Automatic turns allowed between two prompts of the user; only a prompt renews them. It counts
// turns, not model requests: each turn keeps its own step and time limits. Only turns that start
// background work count, since only they can cause more events, and so more turns.
export const MAX_AUTOMATIC_TURNS = 5;

export interface AutoContinueOptions {
  // Nothing else holds the session: no turn or command running, nothing typed, no exit armed.
  isIdle: () => boolean;
  // Background job events are waiting for the model.
  hasEvents: () => boolean;
  // Starts a turn on the pending events and reserves the session before returning, so a second
  // check finds it busy. False when no turn started.
  start: () => boolean;
  notice: (text: string) => void;
  delayMs?: number;
  maxTurns?: number;
}

export interface AutoContinue {
  // Something changed that may let an automatic turn start: an event, a turn or command ending,
  // the input emptied.
  poke(): void;
  // A prompt was accepted: the budget is renewed and a suspension ends.
  userPrompted(): void;
  // Stops starting turns until the next prompt; pending events stay pending.
  pause(): void;
  // A turn that did not end with `done` (interrupted, failed, out of budget) suspends automatic
  // turns, so a failing task is not retried on its own. An automatic turn that started no
  // background work (no job, no subagent) is not counted: it only took events of work that already
  // existed, which are finite, so many reports arriving apart do not exhaust the limit.
  turnEnded(reason: AgentEndReason, startedBackgroundWork: boolean): void;
  dispose(): void;
}

// Decides when the interactive session starts a turn on background events by itself. It
// never reads or takes the events: the turn's loop delivers them to the model.
export const createAutoContinue = (options: AutoContinueOptions): AutoContinue => {
  const delayMs = options.delayMs ?? AUTO_CONTINUE_DELAY_MS;
  const maxTurns = options.maxTurns ?? MAX_AUTOMATIC_TURNS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let turns = 0;
  // Whether the turn running, if any, was started by this scheduler.
  let automaticTurn = false;
  let paused = false;
  let limitShown = false;
  let disposed = false;

  const check = (): void => {
    timer = null;
    if (disposed || paused || !options.hasEvents() || !options.isIdle()) return;
    if (turns >= maxTurns) {
      if (!limitShown) {
        limitShown = true;
        options.notice(
          `Automatic continuation paused after ${maxTurns} turns without a prompt; send a prompt to continue.`,
        );
      }
      return;
    }
    if (options.start()) {
      turns += 1;
      automaticTurn = true;
    }
  };

  return {
    poke() {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(check, delayMs);
    },
    userPrompted() {
      turns = 0;
      automaticTurn = false;
      paused = false;
      limitShown = false;
    },
    pause() {
      paused = true;
    },
    turnEnded(reason, startedBackgroundWork) {
      if (reason !== 'done') paused = true;
      if (automaticTurn && !startedBackgroundWork) turns -= 1;
      automaticTurn = false;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
};

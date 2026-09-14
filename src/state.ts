import type { SupervisorState } from "./types.ts";

const transitions: Record<SupervisorState, readonly SupervisorState[]> = {
  idle: ["starting"],
  starting: ["running", "blocked", "failed", "stopped"],
  running: ["waiting", "paused", "verifying", "blocked", "failed", "stopped"],
  waiting: ["running", "paused", "verifying", "blocked", "failed", "stopped"],
  paused: ["running", "blocked", "stopped", "failed"],
  verifying: ["completed", "running", "blocked", "failed", "stopped"],
  completed: ["idle"],
  blocked: ["idle"],
  failed: ["idle"],
  stopped: ["idle", "blocked"],
};

export class InvalidTransitionError extends Error {
  constructor(from: SupervisorState, to: SupervisorState) {
    super(`Invalid supervisor transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class SupervisorStateMachine {
  #state: SupervisorState = "idle";

  get state(): SupervisorState {
    return this.#state;
  }

  transition(next: SupervisorState): SupervisorState {
    if (!transitions[this.#state].includes(next)) {
      throw new InvalidTransitionError(this.#state, next);
    }
    this.#state = next;
    return this.#state;
  }

  reset(): void {
    this.#state = "idle";
  }
}

export function allowedTransitions(state: SupervisorState): readonly SupervisorState[] {
  return transitions[state];
}

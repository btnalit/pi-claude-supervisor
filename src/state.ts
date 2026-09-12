import type { SupervisorState } from "./types.ts";

const transitions: Record<SupervisorState, readonly SupervisorState[]> = {
  idle: ["starting"],
  starting: ["running", "failed", "stopped"],
  running: ["waiting", "paused", "verifying", "failed", "stopped"],
  waiting: ["running", "paused", "verifying", "failed", "stopped"],
  paused: ["running", "stopped", "failed"],
  verifying: ["completed", "running", "failed", "stopped"],
  completed: ["idle"],
  failed: ["idle"],
  stopped: ["idle"],
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

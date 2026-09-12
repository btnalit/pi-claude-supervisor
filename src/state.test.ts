import assert from "node:assert/strict";
import test from "node:test";
import { InvalidTransitionError, SupervisorStateMachine } from "./state.ts";

test("state machine accepts the verified happy path", () => {
  const machine = new SupervisorStateMachine();
  for (const state of ["starting", "running", "verifying", "completed"] as const) machine.transition(state);
  assert.equal(machine.state, "completed");
});

test("state machine rejects skipping verification", () => {
  const machine = new SupervisorStateMachine();
  machine.transition("starting");
  assert.throws(() => machine.transition("completed"), InvalidTransitionError);
});

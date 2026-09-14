# Recovery follow-up review

The independent read-only review of the recovery changes initially returned
`BLOCK` with three P1 findings, one P2 finding, and a coverage note. The findings
were addressed in this follow-up.

- Stale `starting`/`registered`/`recovered_idle` claims now persist recovery
  owner PID/start time, are reconciled only after the old owner and Worker
  boundary are independently gone, and return to an explicit `interrupted`
  state.
- `--takeover` requires a dead owner, dead Worker/process group, and a verified
  cgroup boundary; missing or unverifiable Worker evidence is rejected.
- Worker registration and `recovered_idle` transitions require an active record,
  persist atomically, and are read back and checked before the recovered session
  is exposed.
- Adopted tmux handoff reports the replaced task and closes its old Decision
  session mapping only after worker identity registration succeeds.
- Session closure now carries cleanup evidence and intent; uncertain cleanup
  retains the active record and cwd lease.

Validation: `npm run check`, `npm run build`, the pinned Claude Code 2.1.270
question matrix (5/5 verified), and the bounded stability evidence in
[`stability-matrix-2.1.270.md`](stability-matrix-2.1.270.md).

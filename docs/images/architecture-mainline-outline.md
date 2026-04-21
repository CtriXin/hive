# Hive Mainline Architecture

## One-line conclusion

Hive v2.1.0 is a real orchestration runtime, not just a planner-to-worker sketch. CLI, MCP, and local Web all drive the same run-time control loop.

## Structure

- Entry surfaces
  - `hive CLI`
  - `MCP tools`
  - `hive web`
- Core runtime
  - run bootstrap + state machine
  - planner + driver loop
  - capability routing + provider resilience
  - workers in isolated git worktrees
  - review cascade + verification + merge
- Cross-cutting control
  - layered policy: `Run > Project > Global > Default`
  - steering and safe-point override behavior
  - discuss / advisory / memory-linked operator context
- Artifacts and surfaces
  - `.ai/runs/<run-id>`
  - CLI operator surfaces
  - Web decision surface and model policy center

## Key relationships

- CLI, MCP, and Web are only different entry surfaces; they do not create separate runtimes.
- Run-time policy applies across planning, worker execution, and review.
- The operator surfaces read from persistent run artifacts rather than ephemeral in-memory state.

## Notes

- The current Web surface is local-first and decision-first.
- It is not yet a hosted product dashboard with auth or websocket push.

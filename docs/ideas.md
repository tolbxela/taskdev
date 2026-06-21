# TaskDev — improvement ideas

Working notes. Nothing here is committed scope; this is the shortlist of
things worth building next, ranked by payoff vs. cost. Skip-lists included
so the file doesn't grow into a wishlist.

## High-value, low-cost

### 1. Health checks (`healthUrl` / `readyPattern`)
A task is "started" the moment the PID exists, but agents really want to
know when it's *ready* (HTTP 200, or "listening on …" in the log). Add an
optional `healthUrl` or `readyPattern` per task; surface a `ready` state in
the sidebar and in `taskdev_status`. Removes the "I started it, why are
requests failing" loop for agents.

### 2. `taskdev_logs` filtering
Add `grep` / `since` / `level` params to `taskdev_logs`. Right now the tool
returns a tail; agents waste tokens scanning for the error they're after.
Filtering at the source keeps responses small without forcing them to read
the full file.

### 3. Port detection + conflict surface
On Windows we already shell to PID-level checks. Knowing the listening port
per task lets us (a) show it in the sidebar (`api · :3000`), (b) detect
"port busy" *before* spawn and offer to kill the squatter, (c) expose
`taskdev_port` to the agent. This is the #1 thing the README pitches
("fight stuck ports") but we don't actually solve it yet.

### 4. Auto-restart on file change (`watch: [...]`)
Optional per-task glob list. When a watched file changes, restart. Many
users wire this up externally (nodemon, watchexec); a first-class field
removes the wrapper layer for simple cases. Keep it opt-in — never default.

### 5. Dependency / startup order (`dependsOn: [...]`)
"Start `api` only after `db` is ready." VS Code tasks have it; combined
with health checks above it becomes useful instead of cosmetic.

## Medium effort, real payoff

### 6. `taskdev_exec` (one-shot commands)
Long-running supervision is our core, but agents also want to run
`npm test`, `tsc --noEmit`, a migration — capture stdout/stderr/exit code
into a log file, return the path + tail. Same security model as
`taskdev_add` (sandboxed, confirmation). Closes the loop where agents
currently fall back to raw shell and lose the structured log.

### 7. Per-task environment files (`envFile: ".env.local"`)
Currently env is inline in `taskdev.json`. Most repos already have `.env*`
files. Reading one (with dotenv-style parsing) avoids duplicating secrets
and stops people from committing them to `taskdev.json`.

### 8. Log rotation policy in config
We keep history in `.taskdev/logs/`. Add `maxLogFiles` / `maxLogBytes` per
project so it doesn't grow forever in long-lived workspaces. Cheap.

### 9. Status-bar item
Single VS Code status-bar entry: "TaskDev: 3 running, 1 failed" → click
opens the view. High visibility for almost no code.

## Worth considering, not urgent

### 10. Crash signal to the agent
Right now if a task exits non-zero unexpectedly, nothing tells the agent.
An MCP "notification"-style resource update, or a `lastExit` field on
`taskdev_status`, lets agents react to a crashed dev server instead of
running blind.

### 11. Per-task colorized log channel
Pipe the live log into a dedicated VS Code OutputChannel per task (in
addition to the file). Useful for "I just want to glance at it" without
opening the editor tab.

---

## Task monitoring (CPU / RAM)

Reasonable, fits cleanly into the PID-centric model we already have.

**Scope:** per-task CPU% + RSS, sampled every ~2s while the sidebar is
visible.

- Sidebar row: `api · running 12m · 0.4% · 128 MB`
- `taskdev_status` adds `cpuPercent`, `rssBytes`, `sampledAt`
- New MCP tool `taskdev_metrics` returns the latest sample (and optionally
  a small ring buffer, e.g. last 30 samples for a tiny sparkline)

That's the whole feature. No charts, no history files, no alerting.

### Why it's useful

- "Is the dev server hung or just slow?" → 0% CPU for 30s answers it.
- "Why is my laptop fan spinning?" → one glance at the sidebar.
- Agents debugging a memory leak get a real signal instead of guessing
  from logs.
- Natural next step after the Windows-perf work in 0.1.20 — same
  PID-centric model.

### Implementation notes

**Process tree, not just the root PID.** Dev servers fork workers (Vite,
Next, dotnet watch). Sample the whole tree and sum. We already do
tree-kill on stop — reuse that pid-walk.

**Platform sampling:**

- Linux/macOS: read `/proc/<pid>/stat` directly (cheap, no spawn). On
  macOS fall back to `ps -o %cpu,rss -p <pid>` — still one spawn per
  sample, but batch *all* PIDs in one call.
- Windows: `process.resourceUsage()` only covers the current process. For
  child PIDs use Node's `os` + a single PowerShell `Get-Process -Id @(...)`
  per tick, batched. **Don't** spawn per task — we just removed that
  pattern. Cache per tick.

**CPU% needs two samples.** Delta of `utime+stime` over wall-clock delta.
First sample after subscribe shows `—`, second shows a real number. Don't
sample more often than 1s — noise without benefit.

**Only sample when something cares.** Pause when the sidebar is hidden AND
no MCP client has called `taskdev_metrics` in the last 30s. Otherwise
we're burning CPU to measure CPU.

**RSS is the honest number.** Don't expose "virtual" or "working set" —
they confuse people and differ across platforms. Pick RSS, document it,
move on.

### What to skip

- **Historical metrics / time-series storage.** Scope creep. If users
  want Grafana, point them at Grafana.
- **Per-thread breakdowns.** Useless for a dev-loop tool.
- **GPU.** No.
- **Disk/network I/O per process.** Expensive to sample correctly on
  Windows, marginal value vs. CPU+RAM.
- **Alerts / "task is using too much memory" notifications.** Annoying,
  configurable-thresholds tax. Let people read the number.

### Sequencing

Build this **after** port detection — port detection requires the same
per-tick syscall budgeting on Windows, and we want to design the
"lightweight per-task probe loop" once, not twice.

---

## What to skip entirely

- Multi-machine / remote orchestration — out of scope for a local
  dev-loop tool.
- A UI for editing `taskdev.json` — the file is the point; a form would
  just rot.
- Profiling / metrics / dashboards beyond the sparkline — that's what the
  user's actual app's tools are for.

## Top three if forced to pick

1. Health checks
2. Port detection
3. `taskdev_exec`

Then CPU/RAM monitoring as #4, reusing the per-tick probe loop from #2.

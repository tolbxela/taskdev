# TaskDev — Progress

## 2026-06-20 project/docs status review

### Implemented but not fully closed
- **Log viewer overhaul** is implemented in source, documented, and covered by
  syntax/core-test validation. Still needs manual Extension Dev Host testing:
  tail, filter, tail off/on, restart reseed, and reload recovery.
- **Task reordering/category editing** is implemented and covered by core tests.
  It is marked implemented in `backlog.md`; still needs manual sidebar drag/drop
  testing in VS Code.
- **Browser-only tasks and starter examples** are implemented and documented.
  Core tests cover loading/listing behavior; sidebar open behavior still needs
  manual smoke testing.
- **VS Code `tasks.json` support** is implemented for direct read-only use:
  workspaces with `.vscode/tasks.json` and no root `taskdev.json` appear as
  TaskDev projects without importing. Start/stop/restart/status/logs/MCP work.
  The original backlog idea of an editable optional
  `storageMode: "vscode-tasks"` is not implemented and should not be treated as
  closed.
- **Bundled extension artifacts** exist under `extension/dist/`, but they are
  stale/untracked compared with current source (`package.json` is 0.1.21 while
  the bundle metadata still shows 0.1.20). The new `extension/scripts/build.cjs`
  references `esbuild`, but `esbuild` is not declared in `extension/package.json`
  and the build script is not wired into package scripts.

### Planned / not implemented
- Health checks: `healthUrl` / `readyPattern`, ready state in sidebar and
  `taskdev_status`.
- Server-side `taskdev_logs` filtering: match/grep, since/until/level-style
  filtering.
- Port detection and conflict surfacing, including a future agent-facing port
  signal.
- File-watch auto-restart via `watch: [...]`.
- Dependency/startup ordering via `dependsOn: [...]`.
- `taskdev_exec` for one-shot commands with captured logs and exit status.
- Per-task `envFile` support.
- Configurable log retention: `maxLogFiles` / `maxLogBytes`.
- Global TaskDev status-bar summary.
- Crash signal/notification path for agents.
- CPU/RAM task monitoring and future `taskdev_metrics`, sequenced after port
  detection.
- MCP spec polish only: tool/resource icons, `Implementation.description`,
  SEP-1303 error-path audit, and future SDK schema-dialect tracking. The MCP
  Tasks extension, cursor pagination for logs, auth, sampling, elicitation, and
  HTTP transport work are explicitly deferred/no-op for TaskDev right now.
- Generated TaskDev comments with website link are still only a backlog idea.

## Task reordering and starter examples
- The log editor renders ANSI colors/styles with VS Code decorations and strips
  unsupported terminal controls; raw log files remain unchanged.
- Browser-only tasks can omit `command` when `openBrowser` is a full URL;
  they open immediately without creating a dummy process or log.
- Added an **Add category…** task context action; an empty value removes it.
- Task rows now show only their names; status and detail remain in tooltips.
- Added mouse drag-and-drop reordering across categories.
- Drop on a task to insert before it, on a category to append there, or on the
  project to remove the category.
- Added **Move task up** / **Move task down** sidebar context actions.
- Reordering persists directly to `taskdev.json`.
- Categorized tasks move within their visible category.
- Newly created task files start with TaskDev home and contact-page examples.

## Current focus: Log viewer overhaul
Top-priority feature (from `backlog.md`): a fast, integrated VS Code log viewer with tail and search/filter — no webview.

### Status: implemented, validated (syntax + core tests), not yet manually tested in VS Code (F5).

## Design decision
- **Surface: read-only virtual document** (`TextDocumentContentProvider`, scheme `taskdev-log`), NOT a webview.
  - Rationale: native find (`Ctrl+F`), native selection/copy, and large-text rendering for free. ANSI SGR styles are layered on with editor decorations.
- **Ordering**: chronological, newest at the bottom.
- **Logs are a shared read-only contract**: the viewer, the MCP tools (`taskdev_logs`, `taskdev_logs_history`, `taskdev://logs/...` resource), and humans all read the same `.taskdev/logs/<name>.<ts>.log` files via the same `core` functions. Viewer filtering and ANSI decoration are UI-only and do NOT affect MCP output.

## Features shipped
- **Tail (follow)**: auto-scroll to newest line on update; on by default.
- **Tail on/off toggle**: single concept replaced the earlier "freeze". Off = pause refresh + auto-scroll (buffer keeps filling underneath; status shows "(new lines)").
- **ANSI rendering**: standard/bright, 256-color, and true-color SGR output plus common text styles.
- **Filter (grep)**: render-time, case-insensitive substring; buffer untouched. Header shows match count.
- **Search/copy**: native `Ctrl+F` + selection (no custom UI by design).
- **Restart-safe**: reopening re-seeds when `currentLogPath` changes.
- **Reload-safe**: `ensureLogState` rebuilds viewer state from the URI after a window reload.

## Performance
- **Trailing-edge throttle, default 500ms (twice/sec)** — bursty output coalesced to ≤1 refresh/window.
- **Incremental reads** — only appended bytes per refresh (offset-based), with truncation/rotation reset.
- **Capped buffer** — `maxLines` default 5000 bounds serialize/diff cost.

## Settings (package.json)
- `taskdev.logViewer.maxLines`: default 5000 (100–100000)
- `taskdev.logViewer.refreshIntervalMs`: default 500 (100–5000)

## Commands / UI
- `taskdev.toggleLogTail` — title-bar `$(arrow-down)` + clickable status bar.
- `taskdev.setLogFilter` — title-bar `$(filter)` (input box; empty clears).
- Status bar shows: tail on/off · filtered · (new lines).

## Files touched
- `extension/extension.js` — replaced OutputChannel-based `showLog` with the virtual-document viewer (provider, tailer, buffer, order/filter/tail, status bar). Registered provider/commands/close + change handlers in `activate()`.
- `extension/package.json` — settings, commands, editor/title menus, activation events.

## Reuses (unchanged) core APIs
`core.currentLogPath`, `core.tailLog`, `core.pathsFor`, `core.listTasks`, `core.TASK_NAME_RE`, `core.TAIL_READ_MAX_BYTES`.

## Validation done
- `node --check extension.js` → OK
- `package.json` parses → OK
- `node test/core.test.cjs` → core tests passed

## Pending / next steps
- Manual test in Extension Dev Host (F5): tail, order flip, filter, tail off/on, restart, reload.
- Optional: auto-pause tail when the Find widget is open (avoid scroll fighting search).
- Optional: full-history search (open raw log file) since filter/search only cover the in-memory buffer (`maxLines`).
- Known cosmetic: pre-existing lint warnings flag every `onCommand` activation event (repo convention, kept for consistency). Could strip all redundant ones in a separate cleanup.

## Notes / environment
- This workspace was re-cloned from `https://github.com/tolbxela/taskdev` (the local `extension/` had been empty). Local `backlog.md` (not in remote) was backed up to `c:\Development\taskdev_local_backup\` and restored.
- Extension is plain JS (`extension.js`, `core.cjs`, `mcp.mjs`), engine `vscode ^1.80.0`.
</CodeContent>
<EmptyFile>false</EmptyFile>
</invoke>

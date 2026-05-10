# Changelog

## 0.1.18 - 2026-05-10

- **Multi-root workspace UX:** the **Open taskdev.json** picker now also lists workspace folders that don't have a `taskdev.json`, with a one-click "Create in folder: …" entry. No more digging in the file tree to set up a second project.
- **New command** `TaskDev: Create taskdev.json in folder…` — also available in the **Explorer right-click menu** on workspace folder roots.

## 0.1.17 - 2026-05-10

- Extension now stops all running tasks on deactivate to prevent orphaned processes.
- Expanded README with detailed sidebar UI description, icon resolution, and refresh cadence.
- Added `docs/security-and-config.md` with comprehensive reference for allow-list, env rules, runtime layout, and MCP tools.

## 0.1.16 - 2026-05-08

- Each task start writes a fresh timestamped log file instead of appending to
  one growing log; older runs auto-pruned (keeps last 20 per task).
- MCP `taskdev_logs` now returns the current run by default (smaller payloads,
  fewer tokens) and accepts an optional `file` to read a historical run.
- Added MCP tool `taskdev_logs_history` and resource template
  `taskdev://logs/{name}` for standards-compliant log access.
- Tree-view log icon opens the active run's log (or most recent if stopped).
- Adaptive refresh: 10 s when tasks are running, 60 s when idle or no
  `taskdev.json` is present. Skip process reconciliation when no state file
  exists. Workspace folders added at runtime now get a file-system watcher.

## 0.1.15 - 2026-05-04

- Automatically create `taskdev.json` and `.taskdev/` runtime folders from the
  extension UI.
- Added Cursor MCP config export targets, preselected existing IDE config
  targets, and a Cursor config template.
- Improved task tree presentation with cleaner labels, richer tooltips, and
  optional task icons/details.
- Made task rows non-clickable so only inline start, stop, and log actions run.
- Reduced sidebar refresh overhead by caching tree snapshots and reconciling
  process state less aggressively.

## 0.1.14 - 2026-05-03

- First publish-ready baseline.
- Simplified docs, root MIT license, search-friendly README, and full release
  changelog.
- Prompt after extension upgrades to review MCP configs without silently
  replacing them.

## 0.1.13 - 2026-05-03

- Split publishable extension files into `extension/`.
- Added example task file, privacy notes, changelog, icon, and tests.
- Added `taskdev_remove`.
- Removed silent MCP config rewrites; MCP config writes are user-triggered.
- Scoped activation to the TaskDev view and commands.

## 0.1.12 - 2026-05-03

- Added `taskdev_add` for confirmed MCP task creation.
- Added command validation, environment filtering, and OS-categorized blocked
  commands for MCP-created tasks.
- Expanded README security notes and package metadata.

## 0.1.11 - 2026-05-03

- Refreshed package description for shared process supervision, reliable
  start/stop, and file-backed logs.

## 0.1.10 - 2026-05-03

- Added `taskdev_status`.
- Unified task supervision around detached processes and file-backed logs.
- Added safer log tailing helpers and improved README tool docs.

## 0.1.9 - 2026-04-26

- Small sidebar and packaging polish after the state/logging work.

## 0.1.8 - 2026-04-26

- Added state locking, log rotation, and environment sanitizing.
- Improved MCP and extension handling of task state.

## 0.1.7 - 2026-04-26

- Improved MCP install/update handling for Codex, Claude Code, and Windsurf.
- Added workspace-aware MCP configuration support.

## 0.1.6 - 2026-04-26

- Repackaged the extension with bundled dependencies.

## 0.1.5 - 2026-04-26

- Added MCP config install/update flow in the extension UI.
- Restored full VSIX packaging with dependencies.

## 0.1.4 - 2026-04-26

- Added the TaskDev MCP install command to the sidebar.

## 0.1.3 - 2026-04-26

- Improved the VS Code/Windsurf sidebar flow.
- Added terminal-based task start support in the extension UI.

## 0.1.2 - 2026-04-26

- Added MCP log reading and restart tools.
- Added restart support in core task supervision.

## 0.1.1 - 2026-04-26

- Initial TaskDev VS Code/Windsurf extension.
- Added sidebar task list with start, stop, refresh, open config, and log view.
- Added basic MCP tools for listing and controlling tasks.

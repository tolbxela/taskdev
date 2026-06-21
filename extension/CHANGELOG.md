# Changelog

## 0.1.21 - 2026-06-20

- **Integrated log editor.** The sidebar log button now opens a read-only `taskdev-log` editor instead of an OutputChannel, with native find/copy, chronological output, tail-follow on by default, a tail toggle, and a case-insensitive line filter.
- **ANSI log rendering.** Common ANSI colors and text styles are rendered with VS Code editor decorations while unsupported terminal control sequences are stripped from the displayed text. Raw log files remain unchanged.
- **Task reordering and category editing.** Tasks can be dragged to reorder within a project, dropped onto categories to move groups, or dropped onto the project to remove a category. Context-menu actions for **Move task up**, **Move task down**, and **Add category…** provide keyboard/menu fallbacks.
- **Browser-only tasks.** A task can omit `command` when `openBrowser` is a full `http://` or `https://` URL. These open immediately from the sidebar and do not create a process or log file.
- **Grouped task maps.** `taskdev.json` can use a category-keyed `tasks` object to avoid repeating `category` on every task. Grouped maps are read-only for reorder/category edit commands; use the array form when you want sidebar editing.
- **Direct VS Code task support.** Workspaces with `.vscode/tasks.json` and no root `taskdev.json` now appear as read-only TaskDev projects without importing. TaskDev maps labels to MCP/log-safe names, runs them with TaskDev supervision, and exposes status/logs over MCP.
- Removed the task-level `icon` field from `taskdev.json`; task rows now use TaskDev's inferred/status icons only.
- New `taskdev.json` files now start with TaskDev home/contact browser examples, and the bundled example config mirrors that starter shape.
- Docs now cover browser-only tasks, task reordering, category editing, and ANSI log rendering.
- Added core tests for ANSI parsing, browser-only task loading/listing, task movement, drag/drop-style placement, and category updates.

## 0.1.20 - 2026-05-14

- **Big Windows perf fix.** `isAlive()` now uses `process.kill(pid, 0)` instead of spawning `tasklist` on every reconcile, and the process-fingerprint check is cached per PID for the extension's lifetime. On Windows 11 24H2 (where `wmic` was removed) we no longer fall back to a `powershell.exe` cold start (previously 1–3 s **per task start** while holding the state lock) — we simply skip the fingerprint and rely on the PID-alive check. Reconcile cost drops from "N child-process spawns every 10 s" to a single in-process syscall per task. Starting a dotnet app, opening the log, and stopping tasks should now feel instant.
- **Bounded log responses for MCP.** `taskdev_logs` gains a `bytes` parameter (default 32 KB, max 128 KB) on top of `lines`, so agents can ask for more context without pulling a multi-MB log into the model. When the response is only the tail of a larger file we prepend a one-line `[taskdev: showing last X of Y bytes; raise \`bytes\` or read taskdev_logs_history.path directly]` header. The `taskdev://logs/...` resource is likewise capped at the last 256 KB. For deeper analysis the agent reads the file at `path` (from `taskdev_logs_history`) directly with its own file tool — keeps the MCP tool small and predictable.
- `tailLog()` returns `{ logSize, returnedBytes, truncated }` metadata and clamps requested byte budgets to `TAIL_READ_MAX_BYTES`.
- **Subfolder `taskdev.json` discovery.** TaskDev now finds task files anywhere under each workspace folder — perfect for monorepos with `apps/web/taskdev.json`, `services/api/taskdev.json`, and so on. Common build / cache / VCS directories are skipped: `.git`, `.hg`, `.svn`, `node_modules`, `bin`, `obj`, `dist`, `build`, `out`, `target`, `.next`, `.nuxt`, `.svelte-kit`, `.astro`, `.angular`, `.parcel-cache`, `.cache`, `.turbo`, `.vercel`, `.netlify`, `coverage`, `.nyc_output`, `__pycache__`, `.venv`, `venv`, `.tox`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `vendor`, `Pods`, `DerivedData`, `.vscode`, `.idea`, `.taskdev`.
- A nested `taskdev.json` *inside* another project's subtree is ignored — the outer one wins. One project owns its tree.
- Project names fall back to the relative path from the workspace folder (`apps/web` rather than just `web`), so monorepos get clean disambiguation out of the box.
- **No periodic filesystem scans.** Discovery runs only on activate, on `taskdev.json` create/change/delete (via the file watcher), on the **Refresh** button, and on workspace folder add/remove. The periodic sidebar tick only re-reads task state from already-discovered projects.
- **New command `TaskDev: Send feedback`** — opens the contact form at [taskdev.dev/contact](https://taskdev.dev/contact). Available from the command palette.

## 0.1.19 - 2026-05-12

- **Multi-root MCP support:** the MCP server now discovers every `taskdev.json` across all open workspace folders instead of being locked to one. Each project keeps its own `.taskdev/` state and logs.
- **New tool** `taskdev_projects` — lists available projects (name from the `project` field in `taskdev.json`, falling back to the folder name; collisions disambiguated as `"Name (folder)"`).
- Every MCP tool now accepts an optional `project` argument. In a single-project workspace it's inferred automatically; in multi-project workspaces an unambiguous error lists the available names.
- Log resource URIs become `taskdev://logs/{project}/{name}` when more than one project is present; single-project setups keep `taskdev://logs/{name}` for backward compatibility.
- Extension writes `~/.taskdev/workspaces.json` on activate and whenever workspace folders are added or removed. The MCP server re-reads it on every call, so folder changes take effect without restarting the MCP host.
- **New `openBrowser` task property.** Set to `true` to open `http://localhost:<env.PORT>` when the task starts, a path like `/admin` to append, or a full URL to open as-is. Opens after a short delay so the dev server has time to start listening.
- **New `category` task property.** Optional group label (e.g. `"Extension"`, `"Web Site"`) that renders tasks as collapsible folders in the sidebar. Pure UI metadata — does not affect execution, MCP, or logs. Uncategorized tasks appear at the project level above the groups.
- `taskdev_logs` now returns plain log text on success and a structured error on failure (instead of mixing the two shapes).
- README rewritten to be more engaging for new users; sidebar deep-dive moved out to the split docs.
- New docs at `/docs`: [`usage.md`](https://github.com/tolbxela/taskdev/blob/main/docs/usage.md) (practical recipes), [`config.md`](https://github.com/tolbxela/taskdev/blob/main/docs/config.md) (schema, runtime files, MCP tools), and [`security.md`](https://github.com/tolbxela/taskdev/blob/main/docs/security.md) (trust model, allow-list, denylist). The previous combined `security-and-config.md` was split for clearer separation between policy and reference.

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

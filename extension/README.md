# TaskDev

**Site: [taskdev.dev](https://taskdev.dev)**

TaskDev is a small **VS Code / Windsurf extension / Cursor extension** for local dev tasks,
dev-server logs, and **MCP access for AI coding agents**.

Start your API, frontend, worker, tunnel, or test watcher from the sidebar.
Agents can use the same task list through MCP. You get one place for processes
and one place for logs.

TaskDev works with Codex, Claude Code, Cursor, Windsurf Cascade, and other
tools that support the Model Context Protocol.

## Why Use It

- See running dev commands in the editor.
- Start, stop, and restart tasks without searching through terminals.
- Open task logs with one click.
- Let agents read the same logs when they debug build or dev-server errors.
- Keep task definitions in your repo with `taskdev.json`.

TaskDev is local and simple: plain JSON, local processes, local logs, no network
listener, and no hidden service.

Search terms: VS Code task runner, Windsurf extension, MCP server, AI coding
agent tools, local process manager, dev server logs, `taskdev.json`.

## Quick Start

Create `taskdev.json` in your workspace root:

```json
{
  "project": "My App",
  "tasks": [
    {
      "name": "api",
      "command": "dotnet run --project src/Api",
      "detail": "Starts the backend API",
      "icon": "server-process"
    },
    {
      "name": "ui",
      "type": "npm",
      "command": "npm run dev",
      "cwd": "ui",
      "detail": "Starts the Vite dev server",
      "icon": {
        "id": "globe",
        "color": "terminal.ansiBlue"
      },
      "env": {
        "PORT": "5173"
      }
    }
  ]
}
```

Open the **TaskDev** view from the Activity Bar. See `examples/taskdev.json`
for a minimal example.

## The Sidebar

The TaskDev view lives in the Activity Bar. It shows a tree of projects and
tasks, refreshes itself while work is in progress, and reacts to edits in
`taskdev.json`.

### Layout

- **Project rows** - one per workspace folder that has a `taskdev.json`.
  The row description shows the task count and, when applicable, how many
  are running (for example `3 tasks · 1 running`). The folder icon switches
  to an "opened folder" style while something is running.
- **Task rows** - one per entry in `tasks[]`.

### What a task row shows

- **Icon** - resolved in this order: the task's `icon`, then the
  `taskdev.defaultTaskIcon` setting, then an inferred codicon based on the
  name/command (`beaker` for test-like, `package` for build-like, `globe`
  for dev/serve/watch, `server-process` for api/worker/service, `terminal`
  otherwise). The icon turns green (`charts.green`) while the task is
  running. `icon` may be either a codicon id string or
  `{ "id": "...", "color": "..." }`.
- **Label** - the task `name`.
- **Description** - while running, `running` plus uptime
  (`running · 12m`); otherwise the first non-empty line of `detail`.
- **Tooltip** - name, `detail`, status, command, cwd, type, PID, uptime,
  and log path.

### Buttons on a task row (on hover)

- **play** - visible when the task is stopped. Starts the command with the
  current `env`/`cwd` from `taskdev.json`.
- **stop** - visible when the task is running. Stops the whole process
  tree (`taskkill /T /F` on Windows, `SIGTERM` to the process group
  elsewhere).
- **log** - opens the current log file. If the task has not produced any
  log yet, a toast appears instead.

### Buttons in the view title bar

- **Install MCP config** - open the picker described in the MCP section
  below.
- **Open taskdev.json** - open the task file for the active project. If no
  project has a task file yet, TaskDev creates one in the first workspace
  folder and opens it.
- **Refresh** - force a re-read of `taskdev.json` and a reconcile of
  running PIDs.

### Refresh cadence

TaskDev refreshes the tree automatically:

- every **10 seconds** while at least one task is running
- every **60 seconds** otherwise
- immediately when `taskdev.json` (or `.taskdev.json`) changes
- on workspace folder add/remove

## Daily Use

- Edit `taskdev.json`. The sidebar updates on save.
- Use the play and stop buttons to control individual tasks.
- Use the log button to open the current task log; historical runs live in
  `.taskdev/logs/<task>.<timestamp>.log` (kept: last 20 per task).
- Use Refresh after manual edits outside the editor.
- Stopping a task stops its whole process tree.

TaskDev writes runtime files under your workspace:

```text
.taskdev/state.json
.taskdev/logs/<task-name>.log
```

Add `.taskdev/` to `.gitignore`. It is local runtime data.

## Task File

TaskDev looks for:

```text
taskdev.json
.taskdev.json
```

Each folder in a multi-root workspace can have its own task file.

Fields:

| Field | Required | Notes |
| --- | --- | --- |
| `project` | no | Display name. Defaults to the workspace folder name. |
| `name` | yes | Unique task name. Must match `^[A-Za-z0-9_.-]{1,64}$`. |
| `command` | yes | Shell command to run. |
| `cwd` | no | Relative to the task file directory, or absolute. |
| `env` | no | Extra environment variables for the task process. |
| `type` | no | Short category shown in tooltips, such as `npm` or `dotnet`. |
| `detail` | no | Human-friendly description shown in the tree and tooltip. |
| `icon` | no | VS Code codicon name, or `{ "id": "...", "color": "..." }`. |

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `taskdev.defaultTaskIcon` | `auto` | Fallback icon when a task does not define `icon`. Use `auto` for inferred icons, or set a codicon id like `file-code`. |

## MCP For Agents

TaskDev includes an MCP server. Agents can use it to work with the same tasks
you see in the sidebar.

Run **TaskDev: Install MCP config** from the command palette. Choose the agent
or config file you want to update. TaskDev only writes MCP config when you run
this command. Existing IDE config locations are preselected when TaskDev can
detect them.

After an extension upgrade, TaskDev may prompt you to review MCP configs so
agents can point at the new extension path. Nothing is rewritten unless you
choose one or more config targets in the picker.

MCP tools:

- `taskdev_list` - list tasks with status, PID, command, cwd, and log path.
- `taskdev_status` - get one task by name, or all tasks.
- `taskdev_control` - start or stop a task.
- `taskdev_restart` - stop and start a task.
- `taskdev_logs` - read recent log lines from the current run, or from an older run via the `file` argument.
- `taskdev_logs_history` - list previous log files for a task (newest first).
- `taskdev_add` - add a restricted task with confirmation.
- `taskdev_remove` - remove a stopped task with confirmation.

Tasks added by agents are restricted. They require confirmation and only allow
known dev command shapes: `npm` / `pnpm` / `yarn` run scripts,
`dotnet run|watch|test|build`, `cargo run|test|build|watch`, and
`go run|test|build`.

## Trust And Safety

Commands in your own `taskdev.json` are shell commands. Treat task files like
code. Only run them in workspaces you trust.

For MCP-created tasks, TaskDev uses stricter checks:

- no shell chaining, redirects, variables, or subshells
- no path traversal or arguments outside the project
- no risky env overrides: `PATH`, `PATHEXT`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`
- blocked risky executables across Windows, macOS, Linux, and common tools

TaskDev does not collect telemetry. It does not open a network listener. See
`PRIVACY.md` for local data notes.

## Build From Source

From the repo root:

```powershell
node scripts/package-vsix.cjs
windsurf --install-extension versions/taskdev-<version>.vsix
```

The extension package lives in `extension/`. Local task files, logs, MCP config
files, and VSIX outputs stay outside the package.

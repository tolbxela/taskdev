# TaskDev

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

Open the **TaskDev** view from the Activity Bar. Your tasks show clean labels,
icons, status, and useful hover details.

See `examples/taskdev.json` for a minimal example.

## Daily Use

- Use the play and stop buttons to control a task.
- Use the log button to open task output.
- Use refresh after editing `taskdev.json`.
- Tasks can keep running after an editor reload.
- Stop a task to stop its process tree.

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
- `taskdev_logs` - read recent log lines.
- `taskdev_add` - add a restricted task with confirmation.
- `taskdev_remove` - remove a stopped task with confirmation.

Tasks added by agents are restricted. They require confirmation and only allow
known dev command shapes such as `npm run`, `dotnet build/test/run`, `cargo`,
and `go`.

## Trust And Safety

Commands in your own `taskdev.json` are shell commands. Treat task files like
code. Only run them in workspaces you trust.

For MCP-created tasks, TaskDev uses stricter checks:

- no shell chaining, redirects, variables, or subshells
- no path traversal or arguments outside the project
- no risky env overrides like `PATH`, `NODE_OPTIONS`, `LD_*`, or `DYLD_*`
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

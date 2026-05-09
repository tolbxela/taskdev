# TaskDev - a task runner for AI coding agents (MCP)

## A small VS Code extension that gives MCP-enabled agents like Claude Code, Cursor, and Windsurf a real handle on your dev processes.

---

**One place for your dev tasks. One place for your logs. And your AI agent sees them too.**

Like most developers working on web apps, I usually have a few long-running processes open during the day:

- the API server
- the frontend dev server
- a build watcher

Usually one terminal each. That works, but it is not the handiest setup - you end up jumping between tabs to check what is running and where the logs are.

**TaskDev** puts them in one place - and makes them visible to your AI agent over MCP.

![TaskDev sidebar showing a project node with two tasks](./Screenshot%202026-05-10%20001838.png)

## Why I built TaskDev

**Agents can read output, but they can't manage processes.**

AI coding agents - *Codex*, *Claude Code*, *Windsurf Cascade*, *Cursor* - write code well and can read terminal output. What they lack is a stable interface for **starting, stopping, and tracking long-running processes**. So they spawn duplicates, lose track of what is running, fight stuck ports, and retry until the developer takes over.

The [Model Context Protocol](https://modelcontextprotocol.io/) (**MCP**) makes a unified solution possible: one task list that both the developer and the agent can drive.

That is **TaskDev**:

- a sidebar for the developer
- an MCP server for the agent
- one source of truth - same tasks, same processes, same logs
- agent commands are sandboxed (see *Trust and safety* below)

## The agent problem, in detail

Long-running tasks like a web service are the worst case:

- the agent forgets a task is already running and starts it again - and again
- the previous process still holds the port, so the new one fails
- it sometimes takes several attempts to stop a task, burning tokens for no reason
- some agents spawn tasks in hidden terminals or redirect the console output, and the developer doesn't see what is going on
- the agent waits forever on a command that never returns

As a result, failed attempts, wasted tokens, and a developer forced to intervene.

The agent itself is not the issue. It just doesn't have a reliable control interface to manage tasks.

**TaskDev** is a small, lightweight process supervisor that provides exactly that interface - `start`, `stop`, `restart`, `status`, `logs`.

## What it is

A small extension for **VS Code**-based editors (*VS Code*, *Cursor*, *Windsurf*).

- plain JSON config
- local processes
- local logs
- no telemetry

Tasks are defined in `taskdev.json` at the root of the workspace.

## Install TaskDev

Repository: [github.com/tolbxela/taskdev](https://github.com/tolbxela/taskdev) - MIT license.

Install **TaskDev** from the Extensions panel - search for `TaskDev`:

- *VS Code* → [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tolbxela.taskdev)
- *Cursor* and *Windsurf* → [Open VSX Registry](https://open-vsx.org/extension/tolbxela/taskdev)

Then drop a `taskdev.json` in your workspace and run **TaskDev: Install MCP config** to wire up the agent side.

## Configuration

Example for an *ASP.NET Core* + *Vue.js* project:

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
      }
    }
  ]
}
```

Each task needs a `name` and a `command`. Everything else is optional:

- `cwd` - working directory for the command
- `env` - extra environment variables
- `detail` - short description shown in the sidebar
- `icon` - a codicon id, or `{ id, color }`
- `type` - a free-form label like `npm` or `dotnet`

Add as many tasks as you want. Two shapes fit naturally:

- **long-running** - dev server, build watcher, worker, tunnel, test watcher
- **repetitive** - test run, lint, type-check, one-off build, data seed

Both end up in the same sidebar with the same logs, and the agent can start either one on demand.

Multi-root workspaces are supported: each folder can have its own `taskdev.json`.

![Sidebar with the title-bar Open taskdev.json button next to the open config](./Screenshot%202026-05-10%20001858.png)

## The sidebar

Click the **TaskDev** icon in the Activity Bar. You get a tree grouped by project - one node per workspace folder that has a `taskdev.json`. The project header shows the task count and how many are running.

Each task row shows:

- an icon (auto-picked from the name, or whatever you set in `icon`) that turns **green while the task is running**
- the task name, plus either the first line of `detail` or `running · 12m` once started
- a rich tooltip on hover with status, command, `cwd`, PID, uptime, and log path

Inline buttons appear on the task row:

- **play** when the task is stopped
- **stop** when it is running
- **log** to open the current log file in the editor

![Hovering a task row reveals Start task and Show log buttons](./Screenshot%202026-05-10%20001730.png)

Clicking **log** opens the current run in a regular editor tab - searchable, scrollable, and the same file the agent reads over MCP.

![Task log open beside the sidebar](./Screenshot%202026-05-10%20001919.png)

The view title has three more actions:

- **Install MCP config** - wire up agents (see below)
- **Open taskdev.json** - jump to the config, or create one if it is missing
- **Refresh** - re-read the config

The sidebar refreshes itself every 10 seconds while at least one task is running, every 60 seconds otherwise, and immediately when you edit `taskdev.json`. Multi-root workspaces show each project side by side.

## MCP integration

Run **TaskDev: Install MCP config** from the command palette and pick which agents to wire up. Detected config files are pre-checked.

![Install MCP config picker listing Windsurf, Claude Code, Cursor, Codex, and workspace-scoped configs](./Screenshot%202026-05-10%20001800.png)

> The MCP config is only written when this command runs. Nothing happens implicitly.

One necessary drawback is that the MCP config stores the installed extension path, which changes with each new TaskDev version. So **you need to re-run TaskDev: Install MCP config after each update**. TaskDev will prompt you after an upgrade, but the configs are only rewritten when you confirm in the picker.

The agent gets eight tools:

| Tool | Purpose |
|---|---|
| `taskdev_list` | list tasks with status, PID, command, cwd, log path |
| `taskdev_status` | status of one task or all |
| `taskdev_control` | start or stop a task |
| `taskdev_restart` | stop and start |
| `taskdev_logs` | read recent log lines (current run, or an older run by file) |
| `taskdev_logs_history` | list previous log files for a task |
| `taskdev_add` | add a task (with confirmation) |
| `taskdev_remove` | remove a stopped task (with confirmation) |

Agents communicate with TaskDev over MCP and can manage tasks efficiently.

Typical agent loop: change code → `taskdev_restart api` → `taskdev_logs api` → read the error → fix or report.

No retry loops. No hung commands. No wasted tokens.

## Trust and safety

Commands in your own `taskdev.json` are normal shell commands - treat the file like code, and only run it in trusted workspaces.

Agent-added tasks (`taskdev_add`) are sandboxed:

- no shell chaining, redirects, variables, or subshells
- no path traversal or arguments outside the project
- no risky env overrides (`PATH`, `NODE_OPTIONS`, dynamic-loader vars, ...)
- only known dev command shapes - `npm` / `pnpm` / `yarn` scripts, `dotnet`, `cargo`, `go`
- explicit confirmation before any add or remove

The agent can spin up `dotnet test`. It cannot invent `curl ... | sh`.

For the exact allow-list, env rules, runtime layout, and MCP tool reference, see [security-and-config.md](https://github.com/tolbxela/taskdev/blob/main/docs/security-and-config.md). For setup, see the [extension README](https://github.com/tolbxela/taskdev/blob/main/extension/README.md).

## Feedback

Found a bug or have an idea? Open an issue at [github.com/tolbxela/taskdev/issues](https://github.com/tolbxela/taskdev/issues).

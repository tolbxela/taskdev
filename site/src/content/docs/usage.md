---
title: "Usage Guide"
order: 1
summary: "Practical recipes for setting up TaskDev in real projects."
source: "usage.md"
---
Practical recipes for setting up TaskDev in real projects. For the precise
allow-list and security rules, see [`security.md`](/docs/security). For the full
`taskdev.json` schema and MCP tools reference, see [`config.md`](/docs/config).

## Contents

1. [First-time setup](#1-first-time-setup)
2. [Common task shapes](#2-common-task-shapes)
3. [Multi-root workspaces](#3-multi-root-workspaces)
4. [openBrowser recipes](#4-openbrowser-recipes)
5. [Per-agent MCP setup](#5-per-agent-mcp-setup)
6. [Driving TaskDev from your agent](#6-driving-taskdev-from-your-agent)
7. [Logs and history](#7-logs-and-history)
8. [Updating TaskDev](#8-updating-taskdev)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. First-time setup

1. Install TaskDev from the
   [Marketplace](https://marketplace.visualstudio.com/items?itemName=tolbxela.taskdev)
   or [Open VSX](https://open-vsx.org/extension/tolbxela/taskdev).
2. Open the **TaskDev** view in the Activity Bar.
3. Click **Open taskdev.json** (the title-bar icon). If no config exists,
   TaskDev creates one in your workspace root and opens it.
4. Replace the empty `tasks: []` with one or two real tasks. The sidebar
   refreshes automatically on save.
5. Run **TaskDev: Install MCP config** from the command palette and pick
   the agents you want to wire up.

That's it. Hit play on a task and it runs in the background with a log file
your agent can read over MCP.

Add `.taskdev/` to `.gitignore` — it holds local PIDs and logs, never commit
it.

---

## 2. Common task shapes

### 2.1 A Vite / Next / Astro dev server

```jsonc
{
  "name": "web",
  "command": "npm run dev",
  "cwd": "apps/web",
  "detail": "Starts the Vite dev server",
  "icon": "globe",
  "env": { "PORT": "5173" },
  "openBrowser": true
}
```

`PORT` is read by Vite itself — TaskDev just forwards it. `openBrowser`
opens `http://localhost:5173` after the server starts (see § 4).

### 2.2 A backend API

```jsonc
{
  "name": "api",
  "command": "dotnet watch --project src/Api",
  "detail": "Starts the .NET API in watch mode",
  "icon": "server-process",
  "env": { "ASPNETCORE_ENVIRONMENT": "Development" }
}
```

`dotnet watch` reloads on file changes, so you rarely need to restart this
task by hand. The agent can still call `taskdev_restart api` after a
breaking schema change.

### 2.3 A worker, tunnel, or anything you'd keep alive in its own terminal

```jsonc
{
  "name": "queue",
  "command": "npm run worker",
  "cwd": "services/worker",
  "type": "worker",
  "icon": { "id": "server-process", "color": "terminal.ansiYellow" }
}
```

### 2.4 A one-shot task (test run, lint, build)

```jsonc
{
  "name": "test",
  "command": "npm run test -- --run",
  "detail": "Vitest single-pass run",
  "icon": "beaker"
}
```

Repetitive tasks live in the same sidebar as long-running ones. The agent
can fire them, wait for exit, and read the tail of the log.

### 2.5 Grouping tasks with `category`

Once you have more than a handful of tasks, add a `category` to each one
and the sidebar renders them as collapsible folders:

```jsonc
{
  "tasks": [
    { "name": "compile",     "command": "node scripts/package-vsix.cjs", "category": "Extension" },
    { "name": "log-smoke",   "command": "npm run log-smoke", "cwd": "extension", "category": "Extension" },
    { "name": "site-dev",    "command": "npm run dev", "cwd": "site", "category": "Web Site", "openBrowser": true },
    { "name": "site-build",  "command": "npm run build", "cwd": "site", "category": "Web Site" }
  ]
}
```

- Categories are free-form strings — pick whatever reads well.
- Tasks without a `category` appear at the project level, above the groups.
- Group order follows the order categories first appear in the file.
- Categories are UI-only. MCP tools, logs, and execution ignore them.

### 2.6 Agent-friendly task names

Names show up in tooltips, MCP responses, and tooltips. Keep them short,
unambiguous, and stable. Good: `api`, `web`, `worker`, `test`, `lint`.
Avoid: `Run my API`, `web-server-1`.

---

## 3. Multi-root workspaces

TaskDev supports multi-root workspaces natively. Each workspace folder can
have its own `taskdev.json`. The sidebar shows one node per project; the
MCP server exposes all of them at once.

### 3.1 Add a `taskdev.json` to a second folder

Either:

- Open the TaskDev view → click **Open taskdev.json**. Folders without a
  config show up as `Create in folder: <name>` entries.
- Or right-click the folder in the Explorer → **Create taskdev.json in
  folder…**.

### 3.2 Project names

The project name in the sidebar and in MCP comes from the optional
`project` field in `taskdev.json`. If absent, TaskDev falls back to the
folder name. Duplicates are disambiguated as `Name (folder)`.

```jsonc
{
  "project": "My App",
  "tasks": [ ... ]
}
```

### 3.3 Pointing the agent at the right project

In a multi-root workspace, every MCP tool takes an optional `project`
argument. The agent should:

1. Call `taskdev_projects` first to discover the available names.
2. Pass the matching name as `project` on subsequent calls.

If `project` is omitted in a multi-root setup, the tool returns an error
listing the available projects — so the agent self-corrects.

---

## 4. openBrowser recipes

The `openBrowser` property opens a URL when you start the task **from the
sidebar play button** (it does not fire when the agent starts a task — by
design).

| You want | Set `openBrowser` to |
| --- | --- |
| `http://localhost:<env.PORT>` (PORT defaults to 3000) | `true` |
| `http://localhost:<env.PORT>/admin` | `"/admin"` |
| A specific URL (different host, https, custom port) | `"http://app.local:4000"` |
| Nothing | omit, or `false` |

Examples:

```jsonc
// Vite dev server with auto-open
{ "name": "web", "command": "npm run dev", "env": { "PORT": "5173" }, "openBrowser": true }

// Backend with a /swagger landing page
{ "name": "api", "command": "dotnet run", "env": { "PORT": "5000" }, "openBrowser": "/swagger" }

// HTTPS preview
{ "name": "preview", "command": "npm run preview", "openBrowser": "https://localhost:4173" }
```

The browser opens ~1.5 s after start so the server has time to bind. If
your server takes longer to come up (cold .NET, big webpack build), open
the URL by hand the first time and let `openBrowser` cover the warm restart
case.

---

## 5. Per-agent MCP setup

Run **TaskDev: Install MCP config** from the command palette. The picker
detects existing config locations and pre-checks the right ones. Pick the
targets you want and confirm.

Known targets:

| Target | Path |
| --- | --- |
| Windsurf (global) | `~/.codeium/windsurf/mcp_config.json` |
| Claude Code (global) | `~/.claude.json` |
| Cursor (global) | `~/.cursor/mcp.json` |
| Codex (global) | `~/.codex/config.toml` |
| Workspace Windsurf | `.windsurf/mcp.json` in the first workspace folder |
| Workspace Claude | `.mcp.json` in the first workspace folder |
| Workspace Cursor | `.cursor/mcp.json` in the first workspace folder |

> **After every TaskDev update, re-run Install MCP config.** The MCP entry
> stores the absolute path to the installed `mcp.mjs`, which changes with
> each extension version. TaskDev prompts you after an upgrade.

The MCP server is launched as `node <ext-path>/mcp.mjs` with
`TASKDEV_WORKSPACES_FILE=~/.taskdev/workspaces.json`. The extension updates
that file whenever workspace folders change, so the agent always sees the
current set without restarting.

---

## 6. Driving TaskDev from your agent

This section is for *you*: what you can tell your agent so it makes the
most of TaskDev. Drop these as house rules / system prompt fragments.

### 6.1 Suggested house rules

> Whenever you need to run, restart, or read the output of a dev process,
> use the `taskdev_*` MCP tools instead of running a shell command. Tasks
> are defined in `taskdev.json` at the workspace root.
>
> Before starting a task, call `taskdev_list` to see whether it is already
> running. To capture build/test output, call `taskdev_logs` with the task
> name; do not pipe output into a new shell.
>
> In a multi-root workspace, call `taskdev_projects` first and pass the
> matching `project` name on subsequent calls.
>
> When adding a new task with `taskdev_add`, only use known dev command
> shapes (`npm run`, `pnpm run`, `yarn`, `dotnet run|watch|test|build`,
> `cargo run|test|build|watch`, `go run|test|build`). The user must approve
> the task before it runs.

### 6.2 A typical agent loop

```text
1. taskdev_status api          → is it running?
2. (apply code change)
3. taskdev_restart api         → reload
4. taskdev_logs api lines=200  → check for stack traces
5. fix or report
```

No retry loops. No hung commands. No "is the dev server still running?".

### 6.3 What the agent cannot do

Even with `taskdev_add`, the agent is restricted to dev command shapes,
cannot chain commands, cannot escape the workspace, and cannot override
sensitive env variables (`PATH`, `NODE_OPTIONS`, dynamic-loader vars). See
[`security.md`](/docs/security) for the exact rules.

---

## 7. Logs and history

- The sidebar's **log** button opens the *current* run in an editor tab.
- Historical logs live in `.taskdev/logs/<task>.<UTC-timestamp>.log`.
  TaskDev keeps the last 20 per task and prunes older ones automatically.
- The agent reads logs with `taskdev_logs <name>` (current run) or by
  passing a `file` from `taskdev_logs_history <name>` to read an older
  run.
- The same logs are exposed as MCP resources at `taskdev://logs/<task>` or
  `taskdev://logs/<project>/<task>` for clients that prefer the resources
  API.

---

## 8. Updating TaskDev

1. Update from the Marketplace / Open VSX.
2. Reload the editor when prompted.
3. When TaskDev shows the post-update notification, click **Review MCP
   configs** and confirm the targets in the picker.

Step 3 is required because the MCP entry pins the absolute path to the
extension folder, which changes each version. Nothing is rewritten unless
you confirm.

---

## 9. Troubleshooting

**The sidebar is empty.**
Make sure `taskdev.json` exists at the workspace root (or any open folder
in a multi-root workspace). Click **Refresh**.

**A task shows as stopped but the dev server is still running.**
TaskDev only tracks processes it started itself. If something else started
the server, it won't appear. Close the rogue server and use the play
button.

**The agent can't see my tasks after I added a workspace folder.**
The MCP server picks up folder changes on the next tool call. Ask the
agent to call `taskdev_projects` again. If it still fails, restart the
agent — some hosts cache the tool list.

**`openBrowser` opens too early and shows a connection error.**
Your server takes longer than 1.5 s to bind. Open it by hand once, then
let `openBrowser` cover restarts; or remove `openBrowser` and rely on the
log button.

**The MCP install command writes to the wrong path after an update.**
Re-run **TaskDev: Install MCP config** — it always rewrites the absolute
extension path. This is expected behavior, not a bug.

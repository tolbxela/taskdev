# TaskDev — Configuration Reference

The precise reference for `taskdev.json`, runtime files, editor settings,
and the MCP tools surface. For the trust model and the agent-add allow-list,
see [`security.md`](security.md). For practical setups, see
[`usage.md`](usage.md).

All behavior below is implemented in `extension/core.cjs` and
`extension/extension.js`.

---

## 1. Task name rules

Applies to both user-authored and agent-added tasks.

- Pattern: `^[A-Za-z0-9_.-]{1,64}$`
- 1–64 characters
- letters, digits, `_`, `.`, `-`

Used for: task identity, MCP tool arguments, log filenames.

Source: `TASK_NAME_RE` in `extension/core.cjs`.

---

## 2. `taskdev.json` schema

```jsonc
{
  "project": "My App",                // optional, display name
  "tasks": [
    {
      "name":    "api",               // required, see § 1
      "command": "dotnet run --project src/Api", // required
      "cwd":     "src/Api",           // optional, relative or absolute
      "env":     { "PORT": "5000" },  // optional, see security.md § 4
      "type":    "dotnet",            // optional, free-form metadata
      "detail":  "Starts the API",    // optional, shown in UI
      "icon":    "server-process",    // optional, see § 2.1
      "category": "Backend",          // optional, see § 2.3
      "openBrowser": true             // optional, see § 2.2
    }
  ]
}
```

TaskDev searches each workspace folder **recursively** for `taskdev.json`
(falling back to `.taskdev.json`), so monorepos can have a config per app:

```text
my-monorepo/
├── apps/
│   ├── web/taskdev.json        ← project "web"
│   └── mobile/taskdev.json     ← project "mobile"
├── services/
│   └── api/taskdev.json        ← project "services/api"
└── taskdev.json                ← optional root project
```

A few rules keep this fast and predictable:

- **Excluded directories** are never entered: `.git`, `.hg`, `.svn`,
  `node_modules`, `bin`, `obj`, `dist`, `build`, `out`, `target`,
  `.next`, `.nuxt`, `.svelte-kit`, `.astro`, `.angular`, `.parcel-cache`,
  `.cache`, `.turbo`, `.vercel`, `.netlify`, `coverage`, `.nyc_output`,
  `__pycache__`, `.venv`, `venv`, `.tox`, `.pytest_cache`, `.mypy_cache`,
  `.ruff_cache`, `vendor`, `Pods`, `DerivedData`, `.vscode`, `.idea`,
  `.taskdev`. Matched by exact directory name, case-sensitive.
- **No nesting.** Once a directory has a `taskdev.json`, TaskDev stops
  descending. A second config inside another project's tree is ignored —
  the outer project owns its folder.
- **Project name** defaults to the relative path from the workspace folder
  (`apps/web`, `services/api`) when the JSON doesn't set `project`
  explicitly. Pure root-level configs still use the folder name.
- **No periodic scans.** Discovery only runs on activate, on file watcher
  events (a `taskdev.json` is created / changed / deleted), on the
  **Refresh** button, and on workspace folder add/remove.

### 2.1 `icon` shapes

`icon` accepts either:

- a string — a [VS Code codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html)
  id, e.g. `"server-process"`.
- an object — `{ "id": "globe", "color": "terminal.ansiBlue" }`. The `color`
  must be a valid theme color id.

When `icon` is omitted, TaskDev infers one from the task name/command (see
`inferTaskIcon` in `extension/extension.js`):

| If name/command/type contains | Inferred icon |
| --- | --- |
| `test`, `spec`, `check`, `verify` | `beaker` |
| `build`, `bundle`, `pack`, `publish`, `compile` | `package` |
| `dev`, `serve`, `server`, `start`, `watch` | `globe` |
| `api`, `worker`, `service` | `server-process` |
| (anything else) | `terminal` |

You can override the fallback with the `taskdev.defaultTaskIcon` setting
(see § 4).

### 2.2 `openBrowser`

Opens a URL in the default browser when the task is started from the
sidebar's play button. Accepted values:

| Value | Result |
| --- | --- |
| `true` | Opens `http://localhost:<env.PORT>` (PORT defaults to 3000). |
| `"/admin"` | Opens `http://localhost:<env.PORT>/admin`. |
| `"http://localhost:8080"` | Opens the URL as-is. |
| `false` / omitted | No browser opens. |

The browser is opened ~1.5 s after the task starts so the dev server has a
chance to begin listening. Starting a task via MCP (`taskdev_control`,
`taskdev_restart`) does **not** open the browser — only the sidebar play
button does.

### 2.3 `category`

Optional free-form group label, e.g. `"Extension"`, `"Web Site"`,
`"Backend"`. Tasks that share the same label are rendered as a collapsible
folder in the sidebar; uncategorized tasks appear at the project level
above the folders.

Rules:

- String, trimmed, case-sensitive.
- Empty string is treated as no category.
- Group order follows the order categories first appear in `taskdev.json`.
- Does not affect MCP, task execution, logs, or security — it's pure UI
  metadata. The field round-trips through `taskdev_list`/`taskdev_status`
  so agents can surface it if they want.

Example:

```jsonc
{
  "tasks": [
    { "name": "api",       "command": "dotnet watch --project src/Api", "category": "Backend" },
    { "name": "worker",    "command": "npm run worker", "cwd": "services/worker", "category": "Backend" },
    { "name": "web",       "command": "npm run dev", "cwd": "apps/web", "category": "Frontend" },
    { "name": "storybook", "command": "npm run storybook", "cwd": "apps/web", "category": "Frontend" },
    { "name": "test",      "command": "npm run test -- --run" }
  ]
}
```

Renders in the sidebar as:

```text
MyApp
  test                  (uncategorized, shown at project level)
  Backend/
    api
    worker
  Frontend/
    web
    storybook
```

---

## 3. Runtime files

TaskDev creates these next to your `taskdev.json`:

```text
.taskdev/
  state.json                 # known PIDs, started-at, status
  state.json.lock            # transient lock during writes
  logs/
    <task>.log               # symlink-style "current" log path used by the UI
    <task>.<UTC-stamp>.log   # one file per run, e.g. api.20260509T214530000Z.log
```

- TaskDev keeps the **latest 20** historical log files per task and prunes
  older ones automatically (`LOG_HISTORY_KEEP = 20`).
- `taskdev_logs` reads the current run by default. Pass a `file` argument
  from `taskdev_logs_history` to read an older run. The `file` argument is
  validated to be a bare filename matching
  `^<task>\.\d{8}T\d{6}\d{3}Z\.log$`; no slashes or `..` allowed.
- Add `.taskdev/` to `.gitignore`.

---

## 4. Editor settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `taskdev.defaultTaskIcon` | `auto` | Fallback codicon id when a task has no `icon`. `auto` keeps the inferred icons from § 2.1; any other value (e.g. `file-code`) becomes a hard fallback. |

The TaskDev sidebar refreshes:

- every 10 s while at least one task is running,
- every 60 s otherwise,
- on edits to `taskdev.json` / `.taskdev.json` (file watcher),
- on workspace folder add/remove,
- on demand via the **Refresh** button.

---

## 5. MCP tools

| Tool | Args | Effect |
| --- | --- | --- |
| `taskdev_projects`     | — | List projects discovered across configured workspace folders. |
| `taskdev_list`         | `project?` | List all tasks with status, pid, command, cwd, log path. |
| `taskdev_status`       | `name?`, `project?` | Status for one task or all. |
| `taskdev_control`      | `action: "start"\|"stop"`, `name`, `project?` | Start or stop a task. |
| `taskdev_restart`      | `name`, `project?` | Stop then start. |
| `taskdev_logs`         | `name`, `lines?` (1–500, default 100), `file?`, `project?` | Read recent log lines from current or older run. |
| `taskdev_logs_history` | `name`, `project?` | List previous log files (newest first). |
| `taskdev_add`          | `name`, `command`, `cwd?`, `env?`, `confirm: "ADD <name>"`, `project?` | Add a task. See [`security.md`](security.md) for the allow-list. |
| `taskdev_remove`       | `name`, `confirm: "REMOVE <name>"`, `project?` | Remove a stopped task. |

The `project` argument is the value of the `project` field in the target
`taskdev.json` (or its containing folder name when that field is absent).

- **Single project workspace:** omit `project`; it's inferred.
- **Multi-project workspace:** omit `project` and tools return an error
  listing available names. Call `taskdev_projects` first to discover them.

### 5.1 Workspace discovery

The MCP server reads workspace roots from (priority order, merged):

1. `TASKDEV_WORKSPACES_FILE` — a JSON file with `{ "roots": [string, ...] }`
   or a bare array of strings. The extension maintains this at
   `~/.taskdev/workspaces.json` and updates it on activate and on workspace
   folder add/remove. The MCP server re-reads it on every tool call, so
   folder changes take effect without restarting the MCP host.
2. `TASKDEV_WORKSPACE` — single path or list separated by `;` (also `:` on
   non-Windows for back-compat with single-folder installs).
3. `process.cwd()` — final fallback.

### 5.2 Log resources

Logs are exposed as MCP resources:

- Single project: `taskdev://logs/<task>`
- Multi-project: `taskdev://logs/<project>/<task>` (with the project segment
  URL-encoded so spaces and disambiguation suffixes like `Shared (alpha)`
  work).

`resources/list` returns the right form for the current workspace.

# TaskDev — Security, Allow-list, and Configuration Reference

This is the precise reference for what TaskDev allows, blocks, and accepts in
configuration. The user-facing `extension/README.md` and the article in
`docs/taskdev-article.md` are deliberately less detailed; this document is the
source of truth.

All rules below are enforced by `extension/core.cjs`. Line references point at
the current implementation.

---

## 1. Two trust modes

TaskDev distinguishes between two ways a task can enter `taskdev.json`:

1. **User-authored tasks** — anything *you* write into `taskdev.json` by hand
   or via your editor. These are treated as ordinary shell commands. TaskDev
   does **not** restrict them. Only run TaskDev in workspaces you trust.
2. **Agent-added tasks** — anything added through the MCP tool
   `taskdev_add`. These pass through the strict allow-list, denylist, and
   sandboxing rules described below before they are ever written to disk.

The `taskdev_remove` MCP tool can remove any task by name, but only if it is
not currently running and only with explicit confirmation.

---

## 2. Task name rules

Applies to both user-authored and agent-added tasks.

- Pattern: `^[A-Za-z0-9_.-]{1,64}$`
- 1–64 characters
- letters, digits, `_`, `.`, `-`

Used for: task identity, MCP tool arguments, log filenames.

Source: `TASK_NAME_RE` in `extension/core.cjs`.

---

## 3. Command rules (agent-added tasks only)

When the MCP tool `taskdev_add` is called, the `command` string must satisfy
**every** rule in this section. Failing any one of them rejects the task with
a descriptive error.

### 3.1 Length

- Maximum 300 characters after trimming.

### 3.2 Character set

The command must match:

```text
^[A-Za-z0-9_./:@%+=,\-\\ "']+$
```

Allowed characters only: letters, digits, and `_  .  /  :  @  %  +  =  ,  -  \  space  "  '`.

Anything else (including tabs, unicode punctuation, `~`, `*`, `?`, etc.) is
rejected.

### 3.3 No shell metacharacters

The command must not contain any of:

```text
; & | < > $ ( ) \n \r
```

This blocks command chaining, pipes, redirects, variable expansion, command
substitution, subshells, and embedded newlines.

### 3.4 Must use an allowed prefix

The command must match exactly **one** of these patterns (case-insensitive):

| Prefix | Pattern (simplified) |
| --- | --- |
| `npm run`   | `npm run <script> [-- <args>]` |
| `pnpm run`  | `pnpm run <script> [-- <args>]` |
| `yarn`      | `yarn [run] <script> [-- <args>]` |
| `dotnet`    | `dotnet (run\|watch\|test\|build) [args]` |
| `cargo`     | `cargo (run\|test\|build\|watch) [args]` |
| `go`        | `go (run\|test\|build) [args]` |

Examples that **pass**:

- `npm run dev`
- `npm run build -- --watch`
- `pnpm run test`
- `yarn dev`
- `dotnet watch --project src/Api`
- `cargo test`
- `go build ./cmd/server`

Examples that **fail**:

- `npm install` — `install` is not `run`
- `node server.js` — `node` is not in the allow-list
- `bash scripts/dev.sh` — `bash` is denied (see § 3.5)
- `npm run dev && npm run api` — chain operator `&&` is denied

Source: `ALLOWED_COMMAND_PREFIXES` in `extension/core.cjs`.

### 3.5 Executable denylist

Even if a token would otherwise match an allowed prefix, the command is
rejected if it contains any of the following words anywhere (case-insensitive,
matched on word boundaries).

**Common (all platforms):**

```text
curl, docker, ftp, git, java, javac, jar, kubectl, helm, node, npx, perl,
php, podman, python, python3, ruby, scp, ssh, telnet, wget
```

**Linux:**

```text
apk, apt, apt-get, bash, busybox, chmod, chown, crontab, dd, dnf, doas,
kill, killall, lua, mkfs, mount, nc, ncat, netcat, pacman, pkill, reboot,
rm, rmdir, rsync, service, sh, shutdown, shred, socat, su, sudo,
systemctl, umount, yum, zypper
```

**macOS:**

```text
brew, defaults, diskutil, hdiutil, launchctl, open, osascript, plutil,
swift, swiftc
```

**Windows:**

```text
bitsadmin, certutil, choco, cmd, copy, cscript, del, erase, format,
icacls, move, mshta, msiexec, net, netsh, powershell, pwsh, rd, reg,
regsvr32, robocopy, rundll32, scoop, schtasks, sc, setx, takeown,
taskkill, winget, wscript, wsl, wsl.exe, xcopy
```

The denylist is applied **regardless of the host OS**. Adding `git pull`
inside an `npm run` argument list still trips it.

Source: `BLOCKED_COMMANDS_BY_OS` in `extension/core.cjs`.

### 3.6 No paths outside the project

Each whitespace-separated token in the command is checked. A token is
rejected when:

- it contains a `..` segment (path traversal), or
- it is an absolute path that resolves outside the workspace folder
  containing the task file.

Tokens that look like flags (`--watch`) or simple names (`dev`) are not
treated as paths. For tokens of the form `KEY=value`, only the `value` part is
checked.

---

## 4. `cwd` rules (agent-added tasks only)

- Optional. If omitted, the task runs in the directory containing
  `taskdev.json`.
- Must be a string.
- May be relative (resolved against the task-file directory) or absolute.
- After resolution, it must stay **inside** the task-file directory.
  Anything outside (including absolute paths to other parts of the system) is
  rejected.

User-authored `cwd` is **not** restricted to inside the project; this check
applies only to `taskdev_add`.

---

## 5. `env` rules

Applies to both user-authored and agent-added tasks.

- Optional. If present, must be a plain JSON object (not array, not null).
- Keys must be strings; values are stringified and passed through to the
  spawned child process.
- The task process inherits `process.env` from the editor, then has these
  values merged on top (after the denylist in § 5.2 is applied).

### 5.1 What TaskDev does *not* do with `env`

TaskDev is a process supervisor. It does **not** interpret any specific
environment variable. In particular:

- **`PORT` is not a TaskDev concept.** TaskDev does not bind to it, check it,
  forward it, or even know that the task is a web server. It is just another
  string in the child process's environment. The `PORT` value matters only
  because tools like Vite, Next.js, Express, and ASP.NET Core read
  `process.env.PORT` themselves to decide which port to listen on.
- **`NODE_ENV`, `RUST_LOG`, `ASPNETCORE_*`, etc.** — same story. TaskDev
  passes them through; the framework you run consumes them.
- **No variable expansion.** A value like `"${HOME}/cache"` is passed
  literally; TaskDev does not expand `${...}` or `%VAR%`. If you need an
  expanded value, write it expanded in `taskdev.json`, or set it in your
  shell before launching the editor.
- **No `.env` file loading.** TaskDev does not read `.env`, `.env.local`,
  or any dotenv file. If your task needs that, run a script that loads it
  (e.g. `npm run dev` where the script uses `dotenv-cli` or your framework's
  built-in support).

#### Example

```jsonc
{
  "name": "ui",
  "command": "npm run dev",
  "cwd": "ui",
  "env": {
    "PORT": "5173",          // read by Vite, not by TaskDev
    "NODE_ENV": "development",
    "VITE_API_URL": "http://localhost:5000"
  }
}
```

When TaskDev starts this task it spawns `npm run dev` with the editor's
`process.env` plus those three keys merged on top. Whether the dev server
actually listens on `5173` depends entirely on Vite reading `PORT`.

### 5.2 Denied keys

The following keys are **always** stripped or rejected:

```text
PATH, PATHEXT, NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*
```

- For user-authored tasks: `sanitizeEnv` silently drops these keys before
  the process is spawned.
- For agent-added tasks: presence of any denied key causes
  `taskdev_add` to fail with `blocked env keys: <list>`.

The match is case-insensitive. `DYLD_*` matches everything starting with
`DYLD_` (e.g. `DYLD_INSERT_LIBRARIES`, `DYLD_FRAMEWORK_PATH`).

Source: `ENV_DENYLIST` and `sanitizeEnv` in `extension/core.cjs`.

---

## 6. Confirmation strings

The two state-changing MCP tools require a literal confirmation string. This
prevents an agent from adding or removing a task in a single accidental tool
call.

| Tool | Required `confirm` value |
| --- | --- |
| `taskdev_add`    | `ADD <name>` |
| `taskdev_remove` | `REMOVE <name>` |

Where `<name>` matches the `name` argument exactly. Any other value (or a
missing argument) returns an error and changes nothing on disk.

`taskdev_remove` additionally refuses to remove a task whose process is still
running — stop it first with `taskdev_control`.

---

## 7. `taskdev.json` schema

```jsonc
{
  "project": "My App",                // optional, display name
  "tasks": [
    {
      "name":    "api",               // required, see § 2
      "command": "dotnet run --project src/Api", // required
      "cwd":     "src/Api",           // optional, relative or absolute
      "env":     { "PORT": "5000" },  // optional, see § 5
      "type":    "dotnet",            // optional, free-form metadata
      "detail":  "Starts the API",    // optional, shown in UI
      "icon":    "server-process"     // optional, see § 7.1
    }
  ]
}
```

TaskDev searches for `taskdev.json`, then `.taskdev.json`, walking up from
the workspace folder. Each folder in a multi-root workspace can have its own
task file.

### 7.1 `icon` shapes

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
(see § 9).

---

## 8. Runtime files

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

## 9. Editor settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `taskdev.defaultTaskIcon` | `auto` | Fallback codicon id when a task has no `icon`. `auto` keeps the inferred icons from § 7.1; any other value (e.g. `file-code`) becomes a hard fallback. |

The TaskDev sidebar refreshes:

- every 10 s while at least one task is running,
- every 60 s otherwise,
- on edits to `taskdev.json` / `.taskdev.json` (file watcher),
- on workspace folder add/remove,
- on demand via the **Refresh** button.

---

## 10. MCP tools

| Tool | Args | Effect |
| --- | --- | --- |
| `taskdev_list`         | — | List all tasks with status, pid, command, cwd, log path. |
| `taskdev_status`       | `name?` | Status for one task or all. |
| `taskdev_control`      | `action: "start"\|"stop"`, `name` | Start or stop a task. |
| `taskdev_restart`      | `name` | Stop then start. |
| `taskdev_logs`         | `name`, `lines?` (1–500, default 100), `file?` | Read recent log lines from current or older run. |
| `taskdev_logs_history` | `name` | List previous log files (newest first). |
| `taskdev_add`          | `name`, `command`, `cwd?`, `env?`, `confirm: "ADD <name>"` | Add a task subject to all rules in § 2–§ 5. |
| `taskdev_remove`       | `name`, `confirm: "REMOVE <name>"` | Remove a stopped task. |

The MCP server is started by the extension via `node mcp.mjs` with
`TASKDEV_WORKSPACE` set to the active workspace folder. It exposes no network
listener.

---

## 11. Privacy

- No telemetry.
- No network listener.
- All state, logs, and lock files live under `.taskdev/` inside your
  workspace.
- MCP config files are written **only** when you explicitly run
  **TaskDev: Install MCP config** and pick targets in the picker.

See `extension/PRIVACY.md` for the full local-data note.

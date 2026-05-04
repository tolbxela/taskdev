# MCP registration

Register the TaskDev MCP server with each agent **once**. All registrations
point at the same installed `mcp.mjs` so all agents share state.

After installing the extension via VSIX, the file lives at:

- Windows: `%USERPROFILE%\.windsurf\extensions\tolbxela.taskdev-<version>\mcp.mjs`
  (or `.vscode\extensions\...` for plain VS Code).
- macOS / Linux: `~/.windsurf/extensions/tolbxela.taskdev-<version>/mcp.mjs`.

Adjust the path in the snippets below if your editor uses a different
extensions directory or version.

## Claude Code

Copy [claude-code.json](claude-code.json) into your workspace as `.mcp.json`.

## Windsurf Cascade

Merge [windsurf.json](windsurf.json) into
`%USERPROFILE%\.codeium\windsurf\mcp_config.json` (Windows) or
`~/.codeium/windsurf/mcp_config.json` (macOS/Linux).

## Cursor

Merge [cursor.json](cursor.json) into global `~/.cursor/mcp.json`, or into
your workspace as `.cursor/mcp.json` for project-specific access.

## Codex extension

Codex's MCP config format mirrors the Claude Code shape. Add an entry of the
same form to its config (check Codex docs for the current location). Stdio
transport only — this server is stdio, so it works.

## Tools

- `taskdev_list` — returns all tasks with `{name, command, cwd, pid, status, uptimeMs}`.
- `taskdev_status({name?})` — returns one task by name, or all tasks when omitted.
- `taskdev_control({action, name})` — `action` is `"start"` or `"stop"`.
- `taskdev_add({name, command, cwd?, env?, confirm})` — adds a safe task.
- `taskdev_remove({name, confirm})` — removes a stopped task.
- `taskdev_restart({name})` — stops and starts a task.
- `taskdev_logs({name, lines?})` — tails the task log.

`name` is validated against `^[A-Za-z0-9_.-]{1,64}$`.

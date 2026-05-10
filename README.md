# TaskDev

**Site: [taskdev.dev](https://taskdev.dev)**

**TaskDev is a VS Code and Windsurf extension for running local dev tasks,
viewing logs, and sharing task control with AI coding agents through MCP.**

Use it for the commands you normally keep open in terminals:

- API servers
- frontend dev servers
- workers
- tunnels
- build watchers
- test watchers

TaskDev uses one `taskdev.json` file. The editor sidebar and the MCP server use
the same tasks, state, and logs. This means developers and agents can start,
stop, restart, and inspect the same local processes.

## Why It Exists

AI coding agents are more useful when they can see real logs. They are also
more useful when they can start and stop the same dev tasks as you.

TaskDev gives Codex, Claude Code, Windsurf Cascade, and other MCP clients a
small local tool for this.

TaskDev is not a cloud service, CI runner, or project management app. It is a
local dev task runner and process panel for your editor.

Search terms: VS Code extension, Windsurf extension, MCP server, Model Context
Protocol, AI coding agents, Codex, Claude Code, Cascade, local dev tasks, task
runner, process supervisor, dev server logs, API server, test watcher,
`taskdev.json`.

## Repository Layout

- `extension/` - the VS Code/Windsurf extension package.
- `extension/README.md` - user setup, MCP tools, and safety notes.
- `extension/examples/` - example `taskdev.json` files.
- `extension/AGENT.md` - guide for agents working on this source.
- `scripts/package-vsix.cjs` - builds a VSIX from `extension/`.
- `taskdev.json` - local tasks for this repo.
- `.taskdev/`, `logs/`, `.mcp.json`, `.windsurf/` - local files. They are
  ignored by git and not packaged.

## Commands

Run tests:

```powershell
cd extension
npm test
```

Build the VSIX:

```powershell
node scripts/package-vsix.cjs
```

The VSIX is written to `versions/`.

## License

MIT License. Copyright (c) 2026 Tolbxela.

For setup and MCP usage, see [extension/README.md](extension/README.md).

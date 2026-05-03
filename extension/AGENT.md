# Agent Guide

This repository builds **TaskDev**, a VS Code / Windsurf extension for
supervising long-running developer tasks and exposing them through MCP.

## Repository Layout

- `extension/` - publishable extension package. Run extension tests here.
- `extension/examples/` - examples shipped in the VSIX.
- `scripts/package-vsix.cjs` - packages `extension/` into `versions/`.
- `taskdev.json` - local tasks for working on this repository.
- `.taskdev/`, `logs/`, `.mcp.json`, `.windsurf/` - local runtime/config files.
  Do not commit or package these.

## Preferred Workflow

Use TaskDev MCP tools for long-running tasks so humans and agents see the same
processes and logs.

- `taskdev_list` - list tasks and current status.
- `taskdev_status({ name? })` - inspect one task or all tasks.
- `taskdev_control({ action: "start"|"stop", name })` - start or stop a task.
- `taskdev_restart({ name })` - restart a task after changes.
- `taskdev_logs({ name, lines? })` - read task logs before guessing at errors.
- `taskdev_add({ name, command, cwd?, env?, confirm })` - add a safe task.
- `taskdev_remove({ name, confirm })` - remove a stopped task.

Use raw shell commands for short checks, tests, packaging, and file inspection.
Do not start background services with raw shell if they should appear in the
TaskDev sidebar.

## Common Commands

```powershell
cd extension
npm test
```

```powershell
node scripts/package-vsix.cjs
```

The generated VSIX is written to `versions/`.

## Editing Notes

- Keep extension source inside `extension/`.
- Keep repo-local development files outside `extension/`.
- Do not add root `taskdev.json`, `.taskdev/`, `.mcp.json`, `.windsurf/`, logs,
  or old VSIX artifacts to the package.
- If you change MCP tools, update `extension/README.md`,
  `extension/mcp-configs/README.md`, and tests when appropriate.
- If you change package metadata, keep `extension/package.json` as the single
  version source. The MCP server reads that version.

## Before Finishing

Run:

```powershell
cd extension
npm test
```

For packaging changes, also run:

```powershell
node scripts/package-vsix.cjs
```

Check that the VSIX includes only publishable files and examples, not local
runtime files.

# Privacy

TaskDev stores task configuration, process state, and logs on the local machine.

- No telemetry is collected.
- No network listener is opened by the extension or MCP server.
- Task output is written to `<workspace>/.taskdev/logs/`.
- MCP config files are only written when the user explicitly runs **Install MCP config** and confirms a target.

Tasks are user-authored shell commands. Only run tasks in workspaces you trust.


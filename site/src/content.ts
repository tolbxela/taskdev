export const tagline = "One place for your dev tasks. One place for your logs. And your AI agent sees them too.";

export const subline = "A small VS Code extension that gives MCP-enabled agents like Claude Code, Cursor, and Windsurf a real handle on your dev processes.";

export const features = [
  {
    title: "One sidebar, all your tasks",
    body: "Long-running servers, watchers, build steps — defined in plain JSON, started and stopped from a tree view in VS Code, Cursor, or Windsurf.",
  },
  {
    title: "Logs your agent can actually read",
    body: "Every task writes to a real file. Your editor opens it; the agent reads the same file over MCP. No hidden terminals, no scraped output.",
  },
  {
    title: "MCP control the agent can trust",
    body: "Eight tools — list, status, control, restart, logs, history, add, remove. Agent-added commands are sandboxed: no shell chaining, no traversal, only known dev-command shapes.",
  },
  {
    title: "Local. No telemetry.",
    body: "Tasks run as local processes. Logs stay on disk. Nothing is shipped anywhere. MIT-licensed.",
  },
];

export const links = {
  vscode: "https://marketplace.visualstudio.com/items?itemName=Tolbxela.taskdev",
  ovsx:   "https://open-vsx.org/extension/tolbxela/taskdev",
  github: "https://github.com/tolbxela/taskdev",
  medium: "https://medium.com/@tolbxela/taskdev-a-task-runner-for-ai-coding-agents-mcp-e4adf4902488",
  devto:  "https://dev.to/tolbxela/taskdev-a-task-runner-for-ai-coding-agents-mcp-3kg1",
  author: "https://tolbxela.com",
};

export const installVscode = "code --install-extension Tolbxela.taskdev";
export const installInEditor = 'Extensions panel  →  search "TaskDev"';

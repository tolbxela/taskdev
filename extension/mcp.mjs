#!/usr/bin/env node
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('./core.cjs');
const pkg = require('./package.json');

// ---- workspace discovery ---------------------------------------------------
// Roots are sourced from (in priority order, merged):
//   1. TASKDEV_WORKSPACES_FILE — JSON file with { roots: [string,...] } or [string,...].
//      Re-read on every tool call so the VS Code extension can update it when
//      workspace folders are added or removed without restarting the MCP host.
//   2. TASKDEV_WORKSPACE — single path or list separated by ';' or path.delimiter.
//      Kept for backward compatibility with single-folder installs.
//   3. process.cwd() — final fallback.

function splitRoots(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  // Prefer ';' which is unambiguous on all platforms (Windows drive letters
  // make ':' unsafe to split on).
  const parts = value.includes(';')
    ? value.split(';')
    : process.platform === 'win32' ? [value] : value.split(path.delimiter);
  return parts.map(s => s.trim()).filter(Boolean);
}

function readRootsFile(file) {
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const roots = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.roots) ? parsed.roots
      : [];
    return roots.filter(r => typeof r === 'string' && r.trim());
  } catch {
    return [];
  }
}

function currentProjects() {
  const fromFile = readRootsFile(process.env.TASKDEV_WORKSPACES_FILE);
  const fromEnv = splitRoots(process.env.TASKDEV_WORKSPACE);
  const roots = [...fromFile, ...fromEnv];
  if (!roots.length) roots.push(process.cwd());
  return core.discoverProjects(roots);
}

function selectProject(projects, requested) {
  if (!projects.length) return { ok: false, error: 'no taskdev.json or .vscode/tasks.json found in any configured workspace folder' };
  if (requested) {
    const match = projects.find(p => p.name === requested);
    if (!match) {
      return {
        ok: false,
        error: `unknown project "${requested}". available: ${projects.map(p => p.name).join(', ')}`,
      };
    }
    return { ok: true, project: match };
  }
  if (projects.length === 1) return { ok: true, project: projects[0] };
  return {
    ok: false,
    error: `multiple projects available, specify project: ${projects.map(p => p.name).join(', ')}`,
  };
}

function errResult(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }] };
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

// ---- server ----------------------------------------------------------------

const server = new McpServer({ name: 'taskdev', version: pkg.version });

const projectParam = z.string().regex(core.PROJECT_NAME_RE).optional()
  .describe('Project name (taskdev.json "project" field or folder name). Required when multiple projects are available; call taskdev_projects to list them.');

server.tool(
  'taskdev_projects',
  'List taskdev projects discovered across all configured workspace folders.',
  {},
  async () => {
    const projects = currentProjects();
    return jsonResult(projects.map(p => ({
      name: p.name,
      tasksFile: p.tasksFile,
      root: p.root,
      source: p.imported === 'vscode' ? 'vscode-tasks' : 'taskdev',
      readOnly: !!p.readOnly,
    })));
  },
);

server.tool(
  'taskdev_list',
  'List defined taskdev tasks with status and pid. Pass project to disambiguate in multi-project workspaces.',
  { project: projectParam },
  async ({ project }) => {
    const sel = selectProject(currentProjects(), project);
    if (!sel.ok) return errResult(sel.error);
    return jsonResult(core.listTasks(sel.project.paths));
  },
);

server.tool(
  'taskdev_status',
  'Get status for one task, or all tasks when name is omitted.',
  {
    name: z.string().regex(core.TASK_NAME_RE).optional(),
    project: projectParam,
  },
  async ({ name, project }) => {
    const sel = selectProject(currentProjects(), project);
    if (!sel.ok) return errResult(sel.error);
    const tasks = core.listTasks(sel.project.paths);
    const result = name ? (tasks.find(t => t.name === name) || { ok: false, error: 'unknown task' }) : tasks;
    return jsonResult(result);
  },
);

server.tool(
  'taskdev_control',
  'Start or stop a taskdev task by name.',
  {
    action: z.enum(['start', 'stop']),
    name: z.string().regex(core.TASK_NAME_RE),
    project: projectParam,
  },
  async ({ action, name, project }) => {
    const sel = selectProject(currentProjects(), project);
    if (!sel.ok) return errResult(sel.error);
    const paths = sel.project.paths;
    let result;
    if (action === 'start') {
      const t = core.loadTasks(paths.tasksFile).find(x => x.name === name);
      result = t ? core.startTask(t, paths) : { ok: false, error: 'unknown task' };
    } else {
      result = core.stopTask(name, paths);
    }
    return jsonResult(result);
  },
);

server.tool(
  'taskdev_add',
  'Add a safe new task to the selected project taskdev.json. Requires confirm to equal ADD <name>.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
    command: z.string().min(1).max(300),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    confirm: z.string(),
    project: projectParam,
  },
  async ({ name, command, cwd, env, confirm, project }) => {
    const sel = selectProject(currentProjects(), project);
    if (!sel.ok) return errResult(sel.error);
    const result = core.addTask(sel.project.paths.tasksFile, { name, command, cwd, env }, { confirm });
    return jsonResult(result);
  },
);

server.tool(
  'taskdev_remove',
  'Remove a task from the selected project taskdev.json. Requires confirm to equal REMOVE <name>.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
    confirm: z.string(),
    project: projectParam,
  },
  async ({ name, confirm, project }) => {
    const sel = selectProject(currentProjects(), project);
    if (!sel.ok) return errResult(sel.error);
    const result = core.removeTask(sel.project.paths.tasksFile, name, { confirm });
    return jsonResult(result);
  },
);

// Per-response byte budget for log content. Tuned to fit comfortably inside a
// single MCP message without blowing the context budget of small models.
// Agents that need more tail context raise `bytes`; for an older run they
// call `taskdev_logs_history` and pass its `file` here.
const LOGS_BYTES_DEFAULT = 32 * 1024;
const LOGS_BYTES_MAX = 128 * 1024;

server.tool(
  'taskdev_logs',
  'Read the tail of a task log. Defaults to the last ~100 lines (capped at 32 KB) of the most recent run. Raise `bytes` (up to 131072) for more context. To inspect a previous run, call `taskdev_logs_history` first and pass its `file` here. For deeper analysis of huge logs, read the file directly using the `path` returned by `taskdev_logs_history` — this tool intentionally bounds response size.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
    lines: z.number().int().min(1).max(500).default(100)
      .describe('Soft cap on number of lines to return.'),
    bytes: z.number().int().min(1024).max(LOGS_BYTES_MAX).optional()
      .describe(`Soft cap on bytes to return (default ${LOGS_BYTES_DEFAULT}, max ${LOGS_BYTES_MAX}). The smaller of \`lines\` and \`bytes\` wins.`),
    file: z.string().optional()
      .describe('Specific log file from taskdev_logs_history to read instead of the current run.'),
    project: projectParam,
  },
  async ({ name, lines, bytes, file, project }) => {
    const sel = selectProject(currentProjects(), project);
    if (!sel.ok) return errResult(sel.error);
    const budget = Math.min(bytes ?? LOGS_BYTES_DEFAULT, LOGS_BYTES_MAX);
    const result = core.tailLog(sel.project.paths, name, lines, file, budget);
    if (!result.ok) return errResult(result.error || 'log read failed');
    // Single grep-friendly header so the agent knows when the response is
    // only the tail of a larger file. No paging — if the agent needs more
    // than `bytes=${LOGS_BYTES_MAX}`, it should read the file directly via
    // the `path` from taskdev_logs_history.
    const header = result.truncated
      ? `[taskdev: showing last ${result.returnedBytes} of ${result.logSize} bytes; raise \`bytes\` (max ${LOGS_BYTES_MAX}) or read \`taskdev_logs_history\`.path directly for more]\n`
      : '';
    return { content: [{ type: 'text', text: header + result.text }] };
  },
);

server.tool(
  'taskdev_logs_history',
  'List previous log files for a task (newest first). Pass file from a result back to taskdev_logs to fetch its contents.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
    project: projectParam,
  },
  async ({ name, project }) => {
    const sel = selectProject(currentProjects(), project);
    if (!sel.ok) return errResult(sel.error);
    return jsonResult(core.logHistory(sel.project.paths, name));
  },
);

server.tool(
  'taskdev_restart',
  'Stop and restart a task by name.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
    project: projectParam,
  },
  async ({ name, project }) => {
    const sel = selectProject(currentProjects(), project);
    if (!sel.ok) return errResult(sel.error);
    const paths = sel.project.paths;
    const t = core.loadTasks(paths.tasksFile).find(x => x.name === name);
    if (!t) return jsonResult({ ok: false, error: 'unknown task' });
    return jsonResult(core.restartTask(t, paths));
  },
);

// Log resource. Single-project: taskdev://logs/{name}. Multi-project:
// taskdev://logs/{project}/{name}. We register the multi-form template and
// also list single-form URIs when only one project is present, so existing
// agents keep working.
server.registerResource(
  'taskdev-log',
  new ResourceTemplate('taskdev://logs/{project}/{name}', {
    list: async () => {
      const projects = currentProjects();
      const resources = [];
      for (const p of projects) {
        const encodedProject = encodeURIComponent(p.name);
        for (const t of core.listTasks(p.paths)) {
          resources.push({
            uri: projects.length === 1
              ? `taskdev://logs/${t.name}`
              : `taskdev://logs/${encodedProject}/${t.name}`,
            name: `${p.name}: ${t.name} log`,
            description: `Current log for task "${t.name}" in project "${p.name}" (${t.status}).`,
            mimeType: 'text/plain',
          });
        }
      }
      return { resources };
    },
  }),
  { description: 'Current log for a taskdev task.', mimeType: 'text/plain' },
  async (uri, vars) => {
    // Accept both taskdev://logs/{name} and taskdev://logs/{project}/{name}.
    const projects = currentProjects();
    let projectName = vars.project ? decodeURIComponent(vars.project) : null;
    let taskName = vars.name;
    if (!taskName && projectName) { taskName = projectName; projectName = null; }
    if (!core.TASK_NAME_RE.test(taskName || '')) throw new Error('invalid task name');
    const sel = selectProject(projects, projectName);
    if (!sel.ok) throw new Error(sel.error);
    const logPath = core.currentLogPath(sel.project.paths, taskName);
    // Always read a bounded tail so an MCP host pulling a multi-megabyte log
    // doesn't blow up its context window or the stdio framing.
    let text = '';
    if (logPath && fs.existsSync(logPath)) {
      const tail = core.tailLog(sel.project.paths, taskName, 5000, undefined, core.TAIL_READ_MAX_BYTES);
      if (tail.ok) {
        const header = tail.truncated
          ? `[taskdev: showing last ${tail.returnedBytes} of ${tail.logSize} bytes]\n`
          : '';
        text = header + tail.text;
      }
    }
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
  },
);

await server.connect(new StdioServerTransport());

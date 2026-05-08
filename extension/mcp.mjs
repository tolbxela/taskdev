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

const ws = process.env.TASKDEV_WORKSPACE;
const workspaceRoot = path.resolve(ws || process.cwd());
const tasksFile =
  core.findTasksFile(workspaceRoot, workspaceRoot) ||
  path.join(workspaceRoot, 'taskdev.json');
const paths = core.pathsFor(tasksFile);

const server = new McpServer({ name: 'taskdev', version: pkg.version });

server.tool(
  'taskdev_list',
  'List defined taskdev tasks with status and pid.',
  {},
  async () => ({ content: [{ type: 'text', text: JSON.stringify(core.listTasks(paths)) }] }),
);

server.tool(
  'taskdev_status',
  'Get status for one task, or all tasks when name is omitted.',
  {
    name: z.string().regex(core.TASK_NAME_RE).optional(),
  },
  async ({ name }) => {
    const tasks = core.listTasks(paths);
    const result = name ? (tasks.find(t => t.name === name) || { ok: false, error: 'unknown task' }) : tasks;
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'taskdev_control',
  'Start or stop a taskdev task by name.',
  {
    action: z.enum(['start', 'stop']),
    name: z.string().regex(core.TASK_NAME_RE),
  },
  async ({ action, name }) => {
    let result;
    if (action === 'start') {
      const t = core.loadTasks(paths.tasksFile).find(x => x.name === name);
      result = t ? core.startTask(t, paths) : { ok: false, error: 'unknown task' };
    } else {
      result = core.stopTask(name, paths);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'taskdev_add',
  'Add a safe new task to the current project taskdev.json. Requires confirm to equal ADD <name>.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
    command: z.string().min(1).max(300),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    confirm: z.string(),
  },
  async ({ name, command, cwd, env, confirm }) => {
    const result = core.addTask(paths.tasksFile, { name, command, cwd, env }, { confirm });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'taskdev_remove',
  'Remove a task from the current project taskdev.json. Requires confirm to equal REMOVE <name>.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
    confirm: z.string(),
  },
  async ({ name, confirm }) => {
    const result = core.removeTask(paths.tasksFile, name, { confirm });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'taskdev_logs',
  'Get the last N lines of a task log. By default returns the current (most recent) run. Pass a file from taskdev_logs_history to read an older run.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
    lines: z.number().int().min(1).max(500).default(100),
    file: z.string().optional(),
  },
  async ({ name, lines, file }) => {
    const result = core.tailLog(paths, name, lines, file);
    return { content: [{ type: 'text', text: result.ok ? result.text : JSON.stringify(result) }] };
  },
);

server.tool(
  'taskdev_logs_history',
  'List previous log files for a task (newest first). Pass file from a result back to taskdev_logs to fetch its contents.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
  },
  async ({ name }) => {
    const result = core.logHistory(paths, name);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.tool(
  'taskdev_restart',
  'Stop and restart a task by name.',
  {
    name: z.string().regex(core.TASK_NAME_RE),
  },
  async ({ name }) => {
    const t = core.loadTasks(paths.tasksFile).find(x => x.name === name);
    if (!t) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'unknown task' }) }] };
    const result = core.restartTask(t, paths);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

server.registerResource(
  'taskdev-log',
  new ResourceTemplate('taskdev://logs/{name}', {
    list: async () => ({
      resources: core.listTasks(paths).map(t => ({
        uri: `taskdev://logs/${t.name}`,
        name: `${t.name} log`,
        description: `Current log for task "${t.name}" (${t.status}).`,
        mimeType: 'text/plain',
      })),
    }),
  }),
  { description: 'Current log for a taskdev task.', mimeType: 'text/plain' },
  async (uri, { name }) => {
    if (!core.TASK_NAME_RE.test(name)) throw new Error('invalid task name');
    const logPath = core.currentLogPath(paths, name);
    const text = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
  },
);

await server.connect(new StdioServerTransport());

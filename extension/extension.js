const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.cjs');

let output = null;
function log(msg) { if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`); }

function atomicWriteFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// ---- MCP registration ------------------------------------------------------

function getMcpEntryPath() {
  return path.join(__dirname, 'mcp.mjs').replace(/\\/g, '/');
}

function getMcpEntry(workspacePath) {
  const entry = { command: 'node', args: [getMcpEntryPath()] };
  if (workspacePath) entry.env = { TASKDEV_WORKSPACE: workspacePath };
  return entry;
}

function upsertJsonFile(filePath, updater) {
  let obj = {};
  if (fs.existsSync(filePath)) {
    try { obj = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (e) { throw new Error(`invalid JSON in ${filePath}: ${e.message}`); }
  }
  updater(obj);
  atomicWriteFile(filePath, JSON.stringify(obj, null, 2) + '\n');
}

function getMcpTargets() {
  const home = require('node:os').homedir();
  return {
    windsurfGlobal: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    claudeGlobal:   path.join(home, '.claude.json'),
    cursorGlobal:   path.join(home, '.cursor', 'mcp.json'),
  };
}

function workspaceTargetPath(kind) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;
  if (kind === 'windsurf') return path.join(folder.uri.fsPath, '.windsurf', 'mcp.json');
  if (kind === 'cursor') return path.join(folder.uri.fsPath, '.cursor', 'mcp.json');
  return path.join(folder.uri.fsPath, '.mcp.json');
}

function mcpPick(label, detail, value, presencePath = detail) {
  return { label, detail, value, picked: Boolean(presencePath && fs.existsSync(presencePath)) };
}

async function installMcpConfig() {
  const t = getMcpTargets();
  const home = require('node:os').homedir();
  const codexToml = path.join(home, '.codex', 'config.toml');
  const firstWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
  const options = [
    mcpPick('$(file-code) Windsurf (global)',     t.windsurfGlobal, 'windsurf', path.dirname(t.windsurfGlobal)),
    mcpPick('$(file-code) Claude Code (global)',  t.claudeGlobal,   'claude'),
    mcpPick('$(file-code) Cursor (global)',       t.cursorGlobal,   'cursor', path.dirname(t.cursorGlobal)),
    mcpPick('$(file-code) Codex (global)',        codexToml,        'codex', path.dirname(codexToml)),
    mcpPick('$(file-code) Workspace .windsurf/mcp.json', workspaceTargetPath('windsurf'), 'ws-windsurf', workspaceTargetPath('windsurf') && path.dirname(workspaceTargetPath('windsurf'))),
    mcpPick('$(file-code) Workspace .mcp.json',          workspaceTargetPath('claude'),   'ws-claude'),
    mcpPick('$(file-code) Workspace .cursor/mcp.json',   workspaceTargetPath('cursor'),   'ws-cursor', workspaceTargetPath('cursor') && path.dirname(workspaceTargetPath('cursor'))),
  ];
  const picks = await vscode.window.showQuickPick(options, {
    placeHolder: 'Choose MCP config targets to update',
    canPickMany: true,
  });
  if (!picks?.length) return;
  const errors = [];
  for (const pick of picks) {
    try {
      if (pick.value === 'codex') {
        // TOML format
        let toml = '';
        try { toml = fs.readFileSync(codexToml, 'utf8'); } catch {}
        const env = firstWorkspace ? `\n[mcp_servers.taskdev.env]\nTASKDEV_WORKSPACE = "${firstWorkspace.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n` : '';
        const entry = `\n[mcp_servers.taskdev]\ncommand = "node"\nargs = ["${getMcpEntryPath()}"]\n${env}`;
        if (toml.includes('[mcp_servers.taskdev]')) {
          toml = toml.replace(/(\[mcp_servers\.taskdev\][^\[]*args\s*=\s*\[")[^"]*("\])/,
            `$1${getMcpEntryPath()}$2`);
          if (firstWorkspace && toml.includes('[mcp_servers.taskdev.env]')) {
            toml = toml.replace(/(\[mcp_servers\.taskdev\.env\][^\[]*TASKDEV_WORKSPACE\s*=\s*")[^"]*(")/,
              `$1${firstWorkspace.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}$2`);
          } else if (firstWorkspace) {
            toml += env;
          }
        } else {
          toml += entry;
        }
        atomicWriteFile(codexToml, toml);
      } else {
        let target;
        if (pick.value === 'windsurf')    target = t.windsurfGlobal;
        else if (pick.value === 'claude') target = t.claudeGlobal;
        else if (pick.value === 'cursor') target = t.cursorGlobal;
        else {
          const folders = vscode.workspace.workspaceFolders;
          if (!folders?.length) { errors.push(`${pick.label}: no workspace folder open`); continue; }
          if (pick.value === 'ws-windsurf') target = workspaceTargetPath('windsurf');
          else if (pick.value === 'ws-cursor') target = workspaceTargetPath('cursor');
          else target = workspaceTargetPath('claude');
        }
        upsertJsonFile(target, obj => {
          if (!obj.mcpServers) obj.mcpServers = {};
          const workspacePath = pick.value === 'ws-windsurf' || pick.value === 'ws-claude' || pick.value === 'ws-cursor'
            ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            : firstWorkspace;
          obj.mcpServers['taskdev'] = getMcpEntry(workspacePath);
        });
      }
    } catch (e) { errors.push(`${pick.label}: ${e.message}`); }
  }
  if (errors.length) vscode.window.showErrorMessage(`taskdev MCP install errors:\n${errors.join('\n')}`);
  else vscode.window.showInformationMessage('taskdev: MCP config installed successfully.');
}

function maybePromptMcpInstallAfterUpdate(ctx) {
  const version = ctx.extension?.packageJSON?.version;
  if (!version) return;

  const key = 'taskdev.lastActivatedVersion';
  const previous = ctx.globalState.get(key);
  ctx.globalState.update(key, version);
  if (!previous || previous === version) return;

  vscode.window.showInformationMessage(
    `TaskDev updated to ${version}. Review MCP configs so agents point at this extension version?`,
    'Review MCP configs',
  ).then(choice => {
    if (choice === 'Review MCP configs') {
      vscode.commands.executeCommand('taskdev.installMcp');
    }
  });
}

let provider = null;

function firstDetailLine(detail) {
  return typeof detail === 'string' ? detail.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '' : '';
}

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function inferTaskIcon(task) {
  const text = `${task.name || ''} ${task.type || ''} ${task.command || ''}`.toLowerCase();
  if (/\b(test|spec|check|verify)\b/.test(text)) return 'beaker';
  if (/\b(build|bundle|pack|publish|compile)\b/.test(text)) return 'package';
  if (/\b(dev|serve|server|start|watch)\b/.test(text)) return 'globe';
  if (/\b(api|worker|service)\b/.test(text)) return 'server-process';
  return 'terminal';
}

function defaultTaskIcon(task) {
  const configured = vscode.workspace.getConfiguration('taskdev').get('defaultTaskIcon', 'auto');
  const icon = typeof configured === 'string' ? configured.trim() : '';
  if (!icon || icon === 'auto') return inferTaskIcon(task);
  return icon;
}

function taskThemeIcon(task) {
  const configured = task.icon;
  const fallbackIcon = defaultTaskIcon(task);
  const id = typeof configured === 'string'
    ? configured
    : typeof configured?.id === 'string'
      ? configured.id
      : fallbackIcon;
  const color = typeof configured?.color === 'string'
    ? configured.color
    : task.status === 'running'
      ? 'charts.green'
      : null;
  return color
    ? new vscode.ThemeIcon(id, new vscode.ThemeColor(color))
    : new vscode.ThemeIcon(id);
}

function taskTooltip(task) {
  const lines = [];
  lines.push(task.name);
  if (task.detail) lines.push('', task.detail);
  lines.push('', `status: ${task.status}`, `command: ${task.command}`, `cwd: ${task.cwd}`);
  if (task.type) lines.push(`type: ${task.type}`);
  if (task.pid) lines.push(`pid: ${task.pid}`);
  if (task.uptimeMs) lines.push(`uptime: ${formatUptime(task.uptimeMs)}`);
  if (task.logPath) lines.push(`log: ${task.logPath}`);
  return lines.join('\n');
}

function resolveProjects() {
  const folders = vscode.workspace.workspaceFolders || [];
  const projects = [];
  for (const f of folders) {
    const tasksFile = core.findTasksFile(f.uri.fsPath, f.uri.fsPath);
    if (!tasksFile) continue;
    const cfg = core.loadConfig(tasksFile);
    const projectName = (typeof cfg.project === 'string' && cfg.project.trim()) || f.name;
    projects.push({ name: projectName, paths: core.pathsFor(tasksFile) });
  }
  return projects;
}

const ACTIVE_REFRESH_MS = 10000;
const IDLE_REFRESH_MS = 60 * 1000;

class TreeProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
    this._projects = [];
    this._timer = null;
    this._timerInterval = 0;
    this._rebuild(true);
    this._scheduleTimer();
  }
  dispose() { if (this._timer) clearInterval(this._timer); }
  _scheduleTimer() {
    const hasProjects = this._projects.length > 0;
    const hasRunning = this._projects.some(p => p.tasks.some(t => t.status === 'running'));
    const desired = !hasProjects ? IDLE_REFRESH_MS : (hasRunning ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    if (this._timer && this._timerInterval === desired) return;
    if (this._timer) clearInterval(this._timer);
    this._timerInterval = desired;
    this._timer = setInterval(() => this.refresh(true), desired);
  }
  refresh(reconcile = true) {
    this._rebuild(reconcile);
    this._em.fire();
    this._scheduleTimer();
  }
  _rebuild(reconcile) {
    this._projects = resolveProjects().map(p => {
      const hasState = fs.existsSync(p.paths.stateFile);
      const tasks = core.listTasks(p.paths, { reconcile: reconcile && hasState })
        .map(t => ({ kind: 'task', _project: p, ...t }));
      return { kind: 'project', ...p, tasks };
    });
  }
  getChildren(elem) {
    if (!elem) return this._projects;
    if (elem.kind === 'project') return elem.tasks || [];
    return [];
  }
  getTreeItem(elem) {
    if (elem.kind === 'project') {
      const tasks = elem.tasks || [];
      const running = tasks.filter(t => t.status === 'running').length;
      const item = new vscode.TreeItem(elem.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = tasks.length
        ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`
        : '(no tasks)';
      item.tooltip = `${elem.paths.tasksFile}\n${tasks.length} tasks`;
      item.iconPath = new vscode.ThemeIcon(running ? 'root-folder-opened' : 'root-folder');
      item.contextValue = 'project';
      return item;
    }
    const t = elem;
    const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
    const detail = firstDetailLine(t.detail);
    item.description = t.status === 'running'
      ? `running${t.uptimeMs ? ` · ${formatUptime(t.uptimeMs)}` : ''}`
      : detail;
    item.tooltip = taskTooltip(t);
    item.contextValue = t.status;
    item.iconPath = taskThemeIcon(t);
    return item;
  }
}

function showLog(elem) {
  if (!elem || elem.kind !== 'task' || !core.TASK_NAME_RE.test(elem.name)) return;
  const logPath = core.currentLogPath(elem._project.paths, elem.name);
  if (!logPath || !fs.existsSync(logPath)) {
    vscode.window.showInformationMessage(`taskdev: no log yet for "${elem.name}"`);
    return;
  }
  vscode.workspace.openTextDocument(logPath).then(doc =>
    vscode.window.showTextDocument(doc, { preview: true })
  );
}

function activate(ctx) {
  output = vscode.window.createOutputChannel('taskdev');
  ctx.subscriptions.push(output);
  provider = new TreeProvider();
  ctx.subscriptions.push(provider, vscode.window.registerTreeDataProvider('taskdev.tasks', provider));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('taskdev.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('taskdev.start', elem => {
      if (!elem || elem.kind !== 'task') return;
      const task = core.loadTasks(elem._project.paths.tasksFile).find(x => x.name === elem.name);
      if (!task) return;
      const r = core.startTask(task, elem._project.paths);
      if (!r.ok) vscode.window.showWarningMessage(`taskdev: ${r.error}`);
      provider.refresh();
    }),
    vscode.commands.registerCommand('taskdev.stop', elem => {
      if (!elem || elem.kind !== 'task') return;
      const r = core.stopTask(elem.name, elem._project.paths);
      if (!r.ok) vscode.window.showWarningMessage(`taskdev: ${r.error}`);
      provider.refresh();
    }),
    vscode.commands.registerCommand('taskdev.showLog', showLog),
    vscode.commands.registerCommand('taskdev.installMcp', installMcpConfig),
    vscode.commands.registerCommand('taskdev.openTasksFile', async () => {
      const projects = resolveProjects();
      if (!projects.length) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
          vscode.window.showInformationMessage('taskdev: no workspace folder open');
          return;
        }
        const created = core.createTasksFile(path.join(folder.uri.fsPath, 'taskdev.json'), folder.name);
        provider.refresh();
        const doc = await vscode.workspace.openTextDocument(created.tasksFile);
        vscode.window.showTextDocument(doc);
        return;
      }
      const target = projects.length === 1
        ? projects[0]
        : await vscode.window.showQuickPick(
            projects.map(p => ({ label: p.name, description: p.paths.tasksFile, _p: p })),
            { placeHolder: 'Pick a project' },
          ).then(c => c?._p);
      if (!target) return;
      const doc = await vscode.workspace.openTextDocument(target.paths.tasksFile);
      vscode.window.showTextDocument(doc);
    }),
  );

  const watchers = new Map();
  function watchFolder(f) {
    if (watchers.has(f.uri.toString())) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(f, '{taskdev.json,.taskdev.json}')
    );
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    watchers.set(f.uri.toString(), watcher);
    ctx.subscriptions.push(watcher);
  }
  for (const f of vscode.workspace.workspaceFolders || []) watchFolder(f);
  vscode.workspace.onDidChangeWorkspaceFolders(e => {
    for (const f of e.added) watchFolder(f);
    for (const f of e.removed) {
      const w = watchers.get(f.uri.toString());
      if (w) { w.dispose(); watchers.delete(f.uri.toString()); }
    }
    provider.refresh();
  }, null, ctx.subscriptions);
  maybePromptMcpInstallAfterUpdate(ctx);
}

function deactivate() {
  for (const project of resolveProjects()) {
    const state = core.readState(project.paths.stateFile);
    for (const name of Object.keys(state.tasks || {})) {
      try { core.stopTask(name, project.paths); } catch { /* ignore */ }
    }
  }
}

module.exports = { activate, deactivate };

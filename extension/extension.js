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
  };
}

async function installMcpConfig() {
  const t = getMcpTargets();
  const home = require('node:os').homedir();
  const codexToml = path.join(home, '.codex', 'config.toml');
  const firstWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
  const options = [
    { label: '$(globe) Windsurf (global)',     detail: t.windsurfGlobal, value: 'windsurf' },
    { label: '$(github) Claude Code (global)', detail: t.claudeGlobal,   value: 'claude'   },
    { label: '$(terminal) Codex (global)',     detail: codexToml,        value: 'codex'    },
    { label: '$(file-code) Workspace .windsurf/mcp.json', detail: 'For Windsurf workspace-level config', value: 'ws-windsurf' },
    { label: '$(file-code) Workspace .mcp.json',          detail: 'For Claude Code / Codex workspace',   value: 'ws-claude'   },
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
        else {
          const folders = vscode.workspace.workspaceFolders;
          if (!folders?.length) { errors.push(`${pick.label}: no workspace folder open`); continue; }
          target = pick.value === 'ws-windsurf'
            ? path.join(folders[0].uri.fsPath, '.windsurf', 'mcp.json')
            : path.join(folders[0].uri.fsPath, '.mcp.json');
        }
        upsertJsonFile(target, obj => {
          if (!obj.mcpServers) obj.mcpServers = {};
          const workspacePath = pick.value === 'ws-windsurf' || pick.value === 'ws-claude'
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

class TreeProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
    this._timer = setInterval(() => this._em.fire(), 2000);
  }
  dispose() { clearInterval(this._timer); }
  refresh() { this._em.fire(); }
  getChildren(elem) {
    if (!elem) return resolveProjects().map(p => ({ kind: 'project', ...p }));
    if (elem.kind === 'project') {
      return core.listTasks(elem.paths).map(t => {
        return { kind: 'task', _project: elem, ...t };
      });
    }
    return [];
  }
  getTreeItem(elem) {
    if (elem.kind === 'project') {
      const tasks = this.getChildren(elem);
      const running = tasks.filter(t => t.status === 'running').length;
      const item = new vscode.TreeItem(elem.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = tasks.length
        ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`
        : '(no tasks)';
      item.tooltip = `${elem.paths.tasksFile}\n${tasks.length} tasks`;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'project';
      return item;
    }
    const t = elem;
    const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
    item.description = t.status === 'running'
      ? `pid ${t.pid} · ${t.command}`
      : t.command;
    const lines = [t.command, `cwd: ${t.cwd}`, `status: ${t.status}`];
    if (t.pid) lines.push(`pid: ${t.pid}`);
    if (t.logPath) lines.push(`log: ${t.logPath}`);
    if (t.uptimeMs) lines.push(`uptime: ${Math.round(t.uptimeMs / 1000)}s`);
    item.tooltip = lines.join('\n');
    item.contextValue = t.status;
    item.iconPath = new vscode.ThemeIcon(
      t.status === 'running' ? 'circle-filled' : 'circle-outline',
      new vscode.ThemeColor(t.status === 'running' ? 'charts.green' : 'descriptionForeground'),
    );
    item.command = { command: 'taskdev.showLog', title: 'Show log', arguments: [t] };
    return item;
  }
}

function showLog(elem) {
  if (!elem || elem.kind !== 'task' || !core.TASK_NAME_RE.test(elem.name)) return;
  const logPath = path.join(elem._project.paths.logsDir, `${elem.name}.log`);
  if (!fs.existsSync(logPath)) {
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
        vscode.window.showInformationMessage('taskdev: no taskdev.json found in workspace');
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

  for (const f of vscode.workspace.workspaceFolders || []) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(f, '{taskdev.json,.taskdev.json}')
    );
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    ctx.subscriptions.push(watcher);
  }
  vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh(), null, ctx.subscriptions);
  maybePromptMcpInstallAfterUpdate(ctx);
}

function deactivate() {}

module.exports = { activate, deactivate };

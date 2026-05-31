const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.cjs');

let output = null;
function log(msg) { if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`); }

// Per-task output channels for log tailing. Key: "<tasksFile>:<taskName>"
const _logChannels = new Map();

function showLog(elem) {
  if (!elem || elem.kind !== 'task' || !core.TASK_NAME_RE.test(elem.name)) return;
  const key = `${elem._project.paths.tasksFile}:${elem.name}`;

  // Reuse an existing channel for this task if it's still open.
  if (_logChannels.has(key)) {
    _logChannels.get(key).channel.show(true);
    return;
  }

  const logPath = core.currentLogPath(elem._project.paths, elem.name);
  if (!logPath || !fs.existsSync(logPath)) {
    vscode.window.showInformationMessage(`taskdev: no log yet for "${elem.name}"`);
    return;
  }

  const channel = vscode.window.createOutputChannel(`taskdev: ${elem.name}`);
  let watcher = null;
  let readOffset = 0;

  function appendFrom(offset) {
    let stat;
    try { stat = fs.statSync(logPath); } catch { return offset; }
    if (stat.size <= offset) return offset;
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(logPath, 'r');
    try { fs.readSync(fd, buf, 0, len, offset); } finally { fs.closeSync(fd); }
    channel.append(buf.toString('utf8'));
    return offset + len;
  }

  // Seed with tail (last 200 lines / 64 KB).
  const tail = core.tailLog(elem._project.paths, elem.name, 200);
  if (tail.ok) {
    if (tail.truncated) channel.appendLine(`--- log truncated, showing tail (${tail.logSize} bytes total) ---`);
    channel.append(tail.text);
    // Position read cursor at end of file so the watcher only appends new bytes.
    try { readOffset = fs.statSync(logPath).size; } catch { readOffset = 0; }
  }

  channel.show(true);

  function stopWatcher() {
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    _logChannels.delete(key);
  }

  // Follow the file while the task is running.
  if (elem.status === 'running') {
    try {
      watcher = fs.watch(logPath, () => {
        readOffset = appendFrom(readOffset);
        // Stop following once the task is no longer running.
        const tasks = core.listTasks(elem._project.paths, { reconcile: false });
        const t = tasks.find(x => x.name === elem.name);
        if (!t || t.status !== 'running') stopWatcher();
      });
      watcher.on('error', stopWatcher);
    } catch { /* file watching not available, static tail is fine */ }
  }

  // Clean up when the user closes the panel.
  channel.onDidDispose ? channel.onDidDispose(stopWatcher) : null;
  _logChannels.set(key, { channel, stopWatcher });
}

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

// Path to a JSON file that lists the current VS Code workspace folder roots.
// The MCP server re-reads this on every tool call, so adding/removing a
// workspace folder takes effect without restarting the MCP host.
function getWorkspacesFilePath() {
  const home = require('node:os').homedir();
  return path.join(home, '.taskdev', 'workspaces.json');
}

function writeWorkspacesFile() {
  const folders = vscode.workspace.workspaceFolders || [];
  const roots = folders.map(f => f.uri.fsPath);
  const file = getWorkspacesFilePath();
  try {
    atomicWriteFile(file, JSON.stringify({ updatedAt: new Date().toISOString(), roots }, null, 2) + '\n');
  } catch (e) {
    log(`workspaces file write failed: ${e.message}`);
  }
  return file;
}

function getMcpEntry(workspacePath) {
  const entry = {
    command: 'node',
    args: [getMcpEntryPath()],
    env: { TASKDEV_WORKSPACES_FILE: getWorkspacesFilePath() },
  };
  // Keep TASKDEV_WORKSPACE for backward compatibility with older mcp.mjs.
  if (workspacePath) entry.env.TASKDEV_WORKSPACE = workspacePath;
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
        const tomlEscape = v => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const wsFile = getWorkspacesFilePath();
        const envBody = `TASKDEV_WORKSPACES_FILE = "${tomlEscape(wsFile)}"\n`
          + (firstWorkspace ? `TASKDEV_WORKSPACE = "${tomlEscape(firstWorkspace)}"\n` : '');
        const entry = `\n[mcp_servers.taskdev]\ncommand = "node"\nargs = ["${getMcpEntryPath()}"]\n\n[mcp_servers.taskdev.env]\n${envBody}`;
        if (toml.includes('[mcp_servers.taskdev]')) {
          // Replace the whole taskdev block to keep env in sync.
          toml = toml.replace(/\[mcp_servers\.taskdev\][\s\S]*?(?=\n\[(?!mcp_servers\.taskdev)|$)/, entry.trimStart());
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

  // Track both the version AND the resolved MCP entry path. The path can
  // change without the version changing (e.g. when we move from an
  // unbundled mcp.mjs at the package root to a bundled dist/mcp.mjs);
  // existing MCP host configs still point at the old location, so we want
  // to prompt the user to re-run "Install MCP config" in that case too.
  const versionKey = 'taskdev.lastActivatedVersion';
  const entryKey = 'taskdev.lastActivatedMcpEntry';
  const previousVersion = ctx.globalState.get(versionKey);
  const previousEntry = ctx.globalState.get(entryKey);
  const currentEntry = getMcpEntryPath();
  ctx.globalState.update(versionKey, version);
  ctx.globalState.update(entryKey, currentEntry);

  if (!previousVersion) return;
  const versionChanged = previousVersion !== version;
  const entryChanged = typeof previousEntry === 'string' && previousEntry !== currentEntry;
  if (!versionChanged && !entryChanged) return;

  const reason = entryChanged && !versionChanged
    ? `TaskDev's MCP entry path moved (${previousEntry} -> ${currentEntry}).`
    : `TaskDev updated to ${version}.`;
  vscode.window.showInformationMessage(
    `${reason} Review MCP configs so agents point at this extension version?`,
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
  // Exit states override the configured per-task icon: the warning is
  // load-bearing and shouldn't be hidden by a custom "flame" icon.
  if (task.status === 'exited') {
    const code = task.lastExit?.code;
    if (code === 0) {
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    }
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
  }
  if (task.status === 'exited-unknown') {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
  }
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

// Format the exit reason for sidebar descriptions and tooltips. Windows
// crash codes (0xCxxxxxxx) are huge unsigned integers — render them as
// hex when they look like NTSTATUS to keep the description scannable.
function formatExitReason(lastExit) {
  if (!lastExit) return 'exited';
  if (lastExit.signal) return `killed (${lastExit.signal})`;
  const c = lastExit.code;
  if (c === null || c === undefined) return 'exited';
  if (c >= 0xC0000000) return `exited 0x${c.toString(16).toUpperCase()}`;
  return `exited code ${c}`;
}

function taskTooltip(task) {
  const lines = [];
  lines.push(task.name);
  if (task.detail) lines.push('', task.detail);
  lines.push('', `status: ${task.status}`, `command: ${task.command}`, `cwd: ${task.cwd}`);
  if (task.type) lines.push(`type: ${task.type}`);
  if (task.pid) lines.push(`pid: ${task.pid}`);
  if (task.uptimeMs) lines.push(`uptime: ${formatUptime(task.uptimeMs)}`);
  if (task.lastExit) {
    lines.push(`${formatExitReason(task.lastExit)} at ${new Date(task.lastExit.at).toLocaleString()}`);
  }
  if (task.logPath) lines.push(`log: ${task.logPath}`);
  return lines.join('\n');
}

function discoverWorkspaceProjects() {
  const folders = vscode.workspace.workspaceFolders || [];
  const roots = folders.map(f => f.uri.fsPath);
  return core.discoverProjects(roots);
}

const ACTIVE_REFRESH_MS = 10000;
const IDLE_REFRESH_MS = 60 * 1000;

class TreeProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
    // Cached project metadata (name, paths, tasksFile). Populated by a
    // filesystem scan; the periodic timer NEVER re-scans, it only re-reads
    // task state for each cached project. Discovery only re-runs on:
    //   - activate
    //   - the file watcher firing (taskdev.json created/changed/deleted)
    //   - explicit refresh button / refresh command
    //   - workspace folder add/remove
    this._discovered = [];
    this._projects = [];
    this._timer = null;
    this._timerInterval = 0;
    this._rediscover();
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
    // Periodic tick: refresh task state from already-discovered projects.
    // No filesystem walk happens here.
    this._timer = setInterval(() => this._tick(), desired);
  }
  _tick() {
    this._rebuild(true);
    this._em.fire();
    this._scheduleTimer();
  }
  // Triggered by user-driven events: re-walk the workspace tree.
  refresh(reconcile = true) {
    this._rediscover();
    this._rebuild(reconcile);
    this._em.fire();
    this._scheduleTimer();
  }
  _rediscover() {
    this._discovered = discoverWorkspaceProjects();
  }
  _rebuild(reconcile) {
    this._projects = this._discovered.map(p => {
      const hasState = fs.existsSync(p.paths.stateFile);
      const tasks = core.listTasks(p.paths, { reconcile: reconcile && hasState })
        .map(t => ({ kind: 'task', _project: p, ...t }));
      const children = buildProjectChildren(p, tasks);
      return { kind: 'project', ...p, tasks, children };
    });
  }
  getChildren(elem) {
    if (!elem) return this._projects;
    if (elem.kind === 'project') return elem.children || [];
    if (elem.kind === 'category') return elem.tasks || [];
    return [];
  }
  getTreeItem(elem) {
    if (elem.kind === 'project') {
      const tasks = elem.tasks || [];
      const running = tasks.filter(t => t.status === 'running').length;
      const item = new vscode.TreeItem(elem.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `project:${elem.paths.tasksFile}`;
      item.description = tasks.length
        ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`
        : '(no tasks)';
      item.tooltip = `${elem.paths.tasksFile}\n${tasks.length} tasks`;
      item.iconPath = new vscode.ThemeIcon(running ? 'root-folder-opened' : 'root-folder');
      item.contextValue = 'project';
      return item;
    }
    if (elem.kind === 'category') {
      const tasks = elem.tasks || [];
      const running = tasks.filter(t => t.status === 'running').length;
      const item = new vscode.TreeItem(elem.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `category:${elem._project.paths.tasksFile}:${elem.name}`;
      item.description = tasks.length
        ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`
        : '(no tasks)';
      item.iconPath = new vscode.ThemeIcon(running ? 'folder-opened' : 'folder');
      item.contextValue = 'category';
      return item;
    }
    const t = elem;
    const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
    item.id = `task:${t._project.paths.tasksFile}:${t.name}`;
    if (t.status === 'running') {
      item.description = `running${t.uptimeMs ? ` · ${formatUptime(t.uptimeMs)}` : ''}`;
    } else if (t.status === 'exited' || t.status === 'exited-unknown') {
      const reason = t.status === 'exited-unknown' ? 'exited (no signal)' : formatExitReason(t.lastExit);
      item.description = reason;
    } else {
      item.description = '';
    }
    item.tooltip = taskTooltip(t);
    item.contextValue = t.status;
    item.iconPath = taskThemeIcon(t);
    return item;
  }
}

// Group tasks under their categories, preserving the order in which categories
// first appear in taskdev.json. Uncategorized tasks appear at the project
// level, above any category groups, keeping their original order too.
function buildProjectChildren(project, tasks) {
  const hasCategory = tasks.some(t => t.category);
  if (!hasCategory) return tasks;
  const groups = new Map();
  const uncategorized = [];
  for (const t of tasks) {
    if (!t.category) { uncategorized.push(t); continue; }
    if (!groups.has(t.category)) {
      groups.set(t.category, { kind: 'category', _project: project, name: t.category, tasks: [] });
    }
    groups.get(t.category).tasks.push(t);
  }
  return [...uncategorized, ...groups.values()];
}

function foldersWithoutConfig() {
  // A workspace folder is "without config" if no taskdev.json exists anywhere
  // in its subtree (subject to the same exclude list the discoverer uses).
  // This is what makes the "Create taskdev.json in folder…" picker meaningful
  // in a monorepo where some folders are covered by nested configs.
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.filter(f => core.scanForTasksFiles(f.uri.fsPath, { maxResults: 1 }).length === 0);
}

async function createInFolder(folder, provider) {
  const target = path.join(folder.uri.fsPath, 'taskdev.json');
  const created = core.createTasksFile(target, folder.name);
  provider.refresh();
  const doc = await vscode.workspace.openTextDocument(created.tasksFile);
  await vscode.window.showTextDocument(doc);
  return created;
}

async function openOrCreateTasksFile(provider) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    vscode.window.showInformationMessage('taskdev: no workspace folder open');
    return;
  }
  const projects = discoverWorkspaceProjects();
  const missing = foldersWithoutConfig();

  // No projects yet: if exactly one folder, just create. Otherwise let the user pick.
  if (!projects.length) {
    if (folders.length === 1) {
      await createInFolder(folders[0], provider);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      folders.map(f => ({ label: `$(new-file) Create in folder: ${f.name}`, description: f.uri.fsPath, _folder: f })),
      { placeHolder: 'Pick a folder for the new taskdev.json' },
    );
    if (pick) await createInFolder(pick._folder, provider);
    return;
  }

  // Existing projects: list them, plus any folders that don't have a config yet.
  const items = [
    ...projects.map(p => ({ label: p.name, description: p.paths.tasksFile, _project: p })),
    ...missing.map(f => ({ label: `$(new-file) Create in folder: ${f.name}`, description: f.uri.fsPath, _folder: f })),
  ];

  // If only one project and no candidates to create, skip the picker.
  if (projects.length === 1 && !missing.length) {
    const doc = await vscode.workspace.openTextDocument(projects[0].paths.tasksFile);
    vscode.window.showTextDocument(doc);
    return;
  }

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: missing.length
      ? 'Pick a project, or create taskdev.json in another folder'
      : 'Pick a project',
  });
  if (!pick) return;
  if (pick._folder) {
    await createInFolder(pick._folder, provider);
  } else {
    const doc = await vscode.workspace.openTextDocument(pick._project.paths.tasksFile);
    vscode.window.showTextDocument(doc);
  }
}

async function createTasksFileInFolder(provider, folderArg) {
  // folderArg is either a Uri (from Explorer context menu) or undefined (palette).
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    vscode.window.showInformationMessage('taskdev: no workspace folder open');
    return;
  }

  let folder = null;
  if (folderArg && typeof folderArg === 'object' && folderArg.fsPath) {
    folder = vscode.workspace.getWorkspaceFolder(folderArg);
    if (!folder) {
      vscode.window.showWarningMessage('taskdev: that path is not a workspace folder root');
      return;
    }
  } else {
    const candidates = foldersWithoutConfig();
    if (!candidates.length) {
      vscode.window.showInformationMessage('taskdev: every workspace folder already has a taskdev.json');
      return;
    }
    if (candidates.length === 1) {
      folder = candidates[0];
    } else {
      const pick = await vscode.window.showQuickPick(
        candidates.map(f => ({ label: f.name, description: f.uri.fsPath, _folder: f })),
        { placeHolder: 'Pick a folder for the new taskdev.json' },
      );
      if (!pick) return;
      folder = pick._folder;
    }
  }

  const target = path.join(folder.uri.fsPath, 'taskdev.json');
  if (fs.existsSync(target)) {
    const doc = await vscode.workspace.openTextDocument(target);
    vscode.window.showTextDocument(doc);
    return;
  }
  await createInFolder(folder, provider);
}

function resolveOpenBrowserUrl(task) {
  const value = task.openBrowser;
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('/')) {
      const port = task.env?.PORT || '3000';
      return `http://localhost:${port}${trimmed}`;
    }
    return null;
  }
  const port = task.env?.PORT || '3000';
  return `http://localhost:${port}`;
}

function maybeOpenBrowser(task) {
  const url = resolveOpenBrowserUrl(task);
  if (!url) return;
  // Small delay so the dev server has a chance to start listening.
  setTimeout(() => {
    vscode.env.openExternal(vscode.Uri.parse(url));
  }, 1500);
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
      if (r.ok && !r.alreadyRunning) maybeOpenBrowser(task);
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
    vscode.commands.registerCommand('taskdev.openTasksFile', () => openOrCreateTasksFile(provider)),
    vscode.commands.registerCommand('taskdev.createTasksFile', folderArg => createTasksFileInFolder(provider, folderArg)),
    vscode.commands.registerCommand('taskdev.sendFeedback', () => {
      // Reuses the contact form at taskdev.dev/contact. The ?from query is
      // picked up by site analytics so we can tell extension-driven traffic
      // apart from organic visits.
      vscode.env.openExternal(vscode.Uri.parse('https://taskdev.dev/contact?from=extension'));
    }),
    vscode.commands.registerCommand('taskdev.importVscodeTasks', () => importVscodeTasksCommand(ctx)),
    vscode.commands.registerCommand('taskdev.clearExit', elem => {
      // Reuses stopTask's exit-state cleanup branch: when the entry is
      // already exited, the call just deletes the state record (the
      // explicit user "I saw the warning" acknowledgement). No extra
      // public API needed in core.
      if (!elem || elem.kind !== 'task') return;
      core.stopTask(elem.name, elem._project.paths);
      provider.refresh();
    }),
  );

  const watchers = new Map();
  function watchFolder(f) {
    if (watchers.has(f.uri.toString())) return;
    // Watch every taskdev.json / .taskdev.json anywhere under the workspace
    // folder. VS Code's file system watcher delivers OS-level events for
    // matching files only; the recursive glob does not cause any periodic
    // scanning. A taskdev.json appearing or disappearing triggers a single
    // refresh, which re-walks the workspace to update the project list.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(f, '**/{taskdev.json,.taskdev.json}')
    );
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    watchers.set(f.uri.toString(), watcher);
    ctx.subscriptions.push(watcher);
  }
  for (const f of vscode.workspace.workspaceFolders || []) watchFolder(f);
  writeWorkspacesFile();
  vscode.workspace.onDidChangeWorkspaceFolders(e => {
    for (const f of e.added) watchFolder(f);
    for (const f of e.removed) {
      const w = watchers.get(f.uri.toString());
      if (w) { w.dispose(); watchers.delete(f.uri.toString()); }
    }
    writeWorkspacesFile();
    provider.refresh();
  }, null, ctx.subscriptions);
  maybePromptMcpInstallAfterUpdate(ctx);
  // Fire-and-forget: ask once per workspace if there's a .vscode/tasks.json
  // but no taskdev.json. Imported projects are already visible read-only in
  // the sidebar; the prompt only offers to make them editable by writing a
  // real taskdev.json. Declining permanently is remembered per workspace.
  maybePromptImportVscodeTasks(ctx).catch(err => {
    if (output) output.appendLine(`taskdev: vscode-tasks prompt failed: ${err && err.message}`);
  });
}

// Shared by the activation prompt AND the manual command. Returns true on
// success so the prompt loop can suppress further nagging for this project.
async function runVscodeTasksImport(project) {
  const target = path.join(project.root, 'taskdev.json');
  const r = core.materializeVscodeTasks(project.tasksFile, target);
  if (!r.ok) {
    vscode.window.showWarningMessage(`taskdev: ${r.error}`);
    return false;
  }
  provider.refresh();
  try {
    const doc = await vscode.workspace.openTextDocument(r.tasksFile);
    await vscode.window.showTextDocument(doc);
  } catch { /* opening the file is a nice-to-have */ }
  vscode.window.showInformationMessage(
    `taskdev: imported ${r.tasksCount} task${r.tasksCount === 1 ? '' : 's'} into taskdev.json.`,
  );
  return true;
}

async function maybePromptImportVscodeTasks(ctx) {
  const projects = discoverWorkspaceProjects();
  const imported = projects.filter(p => p.imported === 'vscode');
  if (imported.length === 0) return;
  for (const p of imported) {
    const stateKey = `taskdev.declinedVscodeImport.${p.root}`;
    if (ctx.workspaceState.get(stateKey)) continue;
    let tasksCount;
    try { tasksCount = core.loadTasks(p.tasksFile).length; }
    catch { tasksCount = 0; }
    if (!tasksCount) continue;
    const choice = await vscode.window.showInformationMessage(
      `TaskDev: found ${tasksCount} task${tasksCount === 1 ? '' : 's'} in \`.vscode/tasks.json\` for "${p.name}". Create a \`taskdev.json\` so they're editable in TaskDev and the agent can add more? Your existing \`.vscode/tasks.json\` stays put.`,
      'Create taskdev.json',
      'Not now',
      "Don't show again",
    );
    if (choice === 'Create taskdev.json') {
      await runVscodeTasksImport(p);
    } else if (choice === "Don't show again") {
      ctx.workspaceState.update(stateKey, true);
    }
  }
}

// Command palette entry. Lets users re-trigger the import after dismissing
// the activation prompt, or run it manually any time. Clears the
// "don't show again" suppression for the project being imported so the
// state stays consistent.
async function importVscodeTasksCommand(ctx) {
  const projects = discoverWorkspaceProjects().filter(p => p.imported === 'vscode');
  if (projects.length === 0) {
    vscode.window.showInformationMessage(
      'taskdev: no .vscode/tasks.json found in any workspace folder without an existing taskdev.json.',
    );
    return;
  }
  let target;
  if (projects.length === 1) {
    target = projects[0];
  } else {
    const picks = projects.map(p => ({
      label: p.name,
      description: p.tasksFile,
      project: p,
    }));
    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Import .vscode/tasks.json from which workspace folder?',
    });
    if (!picked) return;
    target = picked.project;
  }
  if (await runVscodeTasksImport(target)) {
    ctx.workspaceState.update(`taskdev.declinedVscodeImport.${target.root}`, undefined);
  }
}

function deactivate() {
  // Stop running tasks when the extension deactivates (window close, extension
  // uninstall/upgrade). This prevents orphaned dev servers, but it also means
  // tasks do not survive editor reloads. If you need true supervisor behavior
  // across reloads, this is the place to revisit.
  for (const project of discoverWorkspaceProjects()) {
    const state = core.readState(project.paths.stateFile);
    for (const name of Object.keys(state.tasks || {})) {
      try { core.stopTask(name, project.paths); } catch { /* ignore */ }
    }
  }
}

module.exports = { activate, deactivate };

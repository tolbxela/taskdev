const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.cjs');

let output = null;
function log(msg) { if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`); }

// ---------------------------------------------------------------------------
// Log viewer
//
// Logs open in a read-only virtual document (scheme "taskdev-log") instead of
// an OutputChannel. This gives native find (Ctrl+F), native selection/copy,
// full control over ordering, and a cheap "freeze" (pause refresh) toggle —
// without the cost/complexity of a webview.
//
// The line buffer is always chronological, with newest entries at the bottom.
// ANSI SGR colors/styles are rendered with editor decorations; unsupported
// terminal control sequences are removed from the displayed text.
// ---------------------------------------------------------------------------
const LOG_SCHEME = 'taskdev-log';
const LOG_VIEW_MAX_LINES_DEFAULT = 5000;
// Trailing-edge throttle: bursty output coalesces into at most one refresh per
// this window. Kept deliberately relaxed so a chatty task can't pin the UI
// thread re-serializing the buffer. User-tunable via logViewer.refreshIntervalMs.
const LOG_REFRESH_THROTTLE_MS = 500;
const TASK_DRAG_MIME = 'application/vnd.code.tree.taskdev.tasks';

// Per-task viewer state. Key: "<tasksFile>:<taskName>".
const _logDocs = new Map();
const _ansiDecorationTypes = new Map();
let _logEmitter = null; // vscode.EventEmitter<Uri> driving content refresh

function logCfg() {
  const cfg = vscode.workspace.getConfiguration('taskdev');
  let maxLines = Number(cfg.get('logViewer.maxLines'));
  if (!Number.isFinite(maxLines)) maxLines = LOG_VIEW_MAX_LINES_DEFAULT;
  maxLines = Math.max(100, Math.min(100000, Math.floor(maxLines)));
  let refreshMs = Number(cfg.get('logViewer.refreshIntervalMs'));
  if (!Number.isFinite(refreshMs)) refreshMs = LOG_REFRESH_THROTTLE_MS;
  refreshMs = Math.max(100, Math.min(5000, Math.floor(refreshMs)));
  return { maxLines, refreshMs };
}

function logKeyFor(tasksFile, name) { return `${tasksFile}:${name}`; }

function logUriFor(tasksFile, name) {
  // Path drives the editor tab title; query keeps the doc unique per task and
  // lets us rebuild state after a window reload.
  return vscode.Uri.from({
    scheme: LOG_SCHEME,
    path: `/${name}.log`,
    query: Buffer.from(tasksFile, 'utf8').toString('base64'),
  });
}

// Decode the "<tasksFile>:<name>" map key back out of a log URI.
function logKeyFromUri(uri) {
  let tasksFile = '';
  try { tasksFile = Buffer.from(uri.query, 'base64').toString('utf8'); } catch { /* ignore */ }
  return logKeyFor(tasksFile, path.basename(uri.path).replace(/\.log$/, ''));
}

// "Follow" / tail: scroll any visible editor for this doc to the newest line.
function revealNewest(doc) {
  const editors = vscode.window.visibleTextEditors.filter(
    e => e.document.uri.toString() === doc.uri.toString(),
  );
  if (!editors.length) return;
  const line = doc.lineCount - 1;
  const range = new vscode.Range(Math.max(0, line), 0, Math.max(0, line), 0);
  for (const e of editors) e.revealRange(range, vscode.TextEditorRevealType.Default);
}

// Append decoded bytes to the buffer, keeping the last complete line in
// `remainder` so we never render half a record. Caps the buffer to maxLines.
function pushLogText(state, text, maxLines) {
  const parts = (state.remainder + text).split('\n');
  state.remainder = parts.pop();
  if (parts.length) {
    state.lines.push(...parts);
    if (state.lines.length > maxLines) {
      state.lines.splice(0, state.lines.length - maxLines);
      state.truncated = true;
    }
  }
}

function renderLog(state) {
  let lines = state.remainder ? state.lines.concat(state.remainder) : state.lines;
  if (state.filter) {
    const needle = state.filter.toLowerCase();
    lines = lines.filter(l => core.stripTerminalSequences(l).toLowerCase().includes(needle));
  }
  const parsed = core.parseTerminalText(lines.join('\n'));
  const flags = [];
  if (state.truncated) flags.push('truncated');
  flags.push(state.tailing ? 'tail on' : 'tail off');
  if (state.filter) flags.push(`filter: "${state.filter}" (${lines.length} match${lines.length === 1 ? '' : 'es'})`);
  const header = `--- taskdev: ${state.name} (${flags.join(', ')}) ---\n`;
  state.ansiSpans = parsed.spans.map(span => ({
    ...span,
    start: span.start + header.length,
    end: span.end + header.length,
  }));
  return `${header}${parsed.text}\n`;
}

function ansiColor(value) {
  return typeof value === 'string' && value.startsWith('ansi')
    ? new vscode.ThemeColor(`terminal.${value}`)
    : value;
}

function ansiDecorationType(style) {
  const key = JSON.stringify(style);
  let type = _ansiDecorationTypes.get(key);
  if (type) return type;
  const lines = [];
  if (style.underline) lines.push('underline');
  if (style.strikethrough) lines.push('line-through');
  type = vscode.window.createTextEditorDecorationType({
    color: ansiColor(style.fg),
    backgroundColor: ansiColor(style.bg),
    fontWeight: style.bold ? 'bold' : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    opacity: style.dim ? '0.65' : undefined,
    textDecoration: lines.length ? lines.join(' ') : undefined,
  });
  _ansiDecorationTypes.set(key, type);
  return type;
}

function applyAnsiDecorations(doc) {
  if (!doc || doc.uri.scheme !== LOG_SCHEME) return;
  const state = _logDocs.get(logKeyFromUri(doc.uri));
  const editors = vscode.window.visibleTextEditors.filter(
    editor => editor.document.uri.toString() === doc.uri.toString(),
  );
  if (!editors.length) return;
  const grouped = new Map();
  for (const span of state?.ansiSpans || []) {
    const type = ansiDecorationType(span.style);
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end)));
  }
  for (const editor of editors) {
    for (const type of _ansiDecorationTypes.values()) {
      editor.setDecorations(type, grouped.get(type) || []);
    }
  }
}

// Seed the buffer from the tail of the current log file and position the read
// cursor at end of file so the watcher only ingests new bytes.
function seedLog(state, maxLines) {
  const tail = core.tailLog(state.paths, state.name, maxLines, undefined, core.TAIL_READ_MAX_BYTES);
  if (tail.ok) {
    state.truncated = !!tail.truncated;
    pushLogText(state, tail.text, maxLines);
  }
  try { state.readOffset = fs.statSync(state.logPath).size; } catch { state.readOffset = 0; }
}

function appendLogFrom(state, maxLines) {
  let stat;
  try { stat = fs.statSync(state.logPath); } catch { return; }
  if (stat.size < state.readOffset) {
    // File truncated or rotated under us: reset the buffer.
    state.readOffset = 0; state.lines = []; state.remainder = ''; state.truncated = false;
  }
  if (stat.size <= state.readOffset) return;
  const len = stat.size - state.readOffset;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(state.logPath, 'r');
  try { fs.readSync(fd, buf, 0, len, state.readOffset); } finally { fs.closeSync(fd); }
  state.readOffset = stat.size;
  pushLogText(state, buf.toString('utf8'), maxLines);
}

// Coalesce bursty fs.watch events into one refresh per throttle window.
function scheduleLogRefresh(state) {
  if (state.throttle) return;
  const { maxLines, refreshMs } = logCfg();
  state.throttle = setTimeout(() => {
    state.throttle = null;
    appendLogFrom(state, maxLines);
    if (!state.tailing) { state.pendingChange = true; return; }
    if (_logEmitter) _logEmitter.fire(state.uri);
  }, refreshMs);
}

function startLogWatcher(state, running) {
  if (!running || state.watcher) return;
  try {
    state.watcher = fs.watch(state.logPath, () => {
      scheduleLogRefresh(state);
      // Stop following once the task is no longer running.
      const tasks = core.listTasks(state.paths, { reconcile: false });
      const t = tasks.find(x => x.name === state.name);
      if (!t || t.status !== 'running') stopLogWatcher(state);
    });
    state.watcher.on('error', () => stopLogWatcher(state));
  } catch { /* file watching unavailable; static tail is fine */ }
}

function stopLogWatcher(state) {
  if (state.watcher) { try { state.watcher.close(); } catch {} state.watcher = null; }
}

function disposeLogState(state) {
  stopLogWatcher(state);
  if (state.throttle) { clearTimeout(state.throttle); state.throttle = null; }
  _logDocs.delete(logKeyFor(state.tasksFile, state.name));
}

// Look up existing viewer state, or rebuild it from the URI (used by the
// content provider after a window reload, when the in-memory map is empty).
function ensureLogState(uri, running) {
  let tasksFile;
  try { tasksFile = Buffer.from(uri.query, 'base64').toString('utf8'); } catch { return null; }
  const name = path.basename(uri.path).replace(/\.log$/, '');
  if (!tasksFile || !core.TASK_NAME_RE.test(name)) return null;
  const key = logKeyFor(tasksFile, name);
  let state = _logDocs.get(key);
  if (state) return state;
  const paths = core.pathsFor(tasksFile);
  const logPath = core.currentLogPath(paths, name);
  if (!logPath || !fs.existsSync(logPath)) return null;
  state = {
    uri, tasksFile, name, paths, logPath,
    lines: [], remainder: '', readOffset: 0,
    truncated: false, tailing: true, pendingChange: false, filter: null,
    watcher: null, throttle: null, ansiSpans: [],
  };
  _logDocs.set(key, state);
  seedLog(state, logCfg().maxLines);
  if (running === undefined) {
    const tasks = core.listTasks(paths, { reconcile: false });
    running = tasks.find(x => x.name === name)?.status === 'running';
  }
  startLogWatcher(state, running);
  return state;
}

class LogContentProvider {
  get onDidChange() { return _logEmitter.event; }
  provideTextDocumentContent(uri) {
    const state = ensureLogState(uri);
    return state ? renderLog(state) : `--- taskdev: no log available ---\n`;
  }
}

async function openLogDocument(uri) {
  const doc = await vscode.workspace.openTextDocument(uri);
  try { await vscode.languages.setTextDocumentLanguage(doc, 'log'); } catch { /* 'log' lang optional */ }
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
  applyAnsiDecorations(doc);
  return doc;
}

function showLog(elem) {
  if (!elem || elem.kind !== 'task' || !core.TASK_NAME_RE.test(elem.name)) return;
  const paths = elem._project.paths;
  const uri = logUriFor(paths.tasksFile, elem.name);
  const key = logKeyFor(paths.tasksFile, elem.name);

  const logPath = core.currentLogPath(paths, elem.name);
  if (!logPath || !fs.existsSync(logPath)) {
    vscode.window.showInformationMessage(`taskdev: no log yet for "${elem.name}"`);
    return;
  }
  // If the task was restarted, currentLogPath now points to a new file; drop
  // the stale viewer state so we re-seed and follow the latest run.
  const existing = _logDocs.get(key);
  if (existing && existing.logPath !== logPath) disposeLogState(existing);
  ensureLogState(uri, elem.status === 'running');
  if (_logEmitter) _logEmitter.fire(uri); // force refresh if the doc was already open
  openLogDocument(uri).then(doc => { revealNewest(doc); }, () => {});
}

function activeLogState() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== LOG_SCHEME) return null;
  return ensureLogState(ed.document.uri);
}

function toggleLogTail() {
  const state = activeLogState();
  if (!state) return;
  state.tailing = !state.tailing;
  state.pendingChange = false;
  // Turning tail back on flushes buffered lines; the change hook then scrolls
  // to the newest line. Turning it off just refreshes the header.
  if (_logEmitter) _logEmitter.fire(state.uri);
}

async function setLogFilter() {
  const state = activeLogState();
  if (!state) return;
  const value = await vscode.window.showInputBox({
    prompt: 'Filter log lines (case-insensitive substring). Leave empty to clear.',
    value: state.filter || '',
    placeHolder: 'e.g. error',
  });
  if (value === undefined) return; // user cancelled
  state.filter = value.trim() || null;
  if (_logEmitter) _logEmitter.fire(state.uri);
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
  if (!task.command && resolveOpenBrowserUrl(task)) return 'link-external';
  if (/\b(test|spec|check|verify)\b/.test(text)) return 'beaker';
  if (/\b(build|bundle|pack|publish|compile)\b/.test(text)) return 'package';
  if (/\b(dev|serve|server|start|watch)\b/.test(text)) return 'globe';
  if (/\b(api|worker|service)\b/.test(text)) return 'server-process';
  return 'terminal';
}

function taskThemeIcon(task) {
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
  const id = inferTaskIcon(task);
  const color = task.status === 'running' ? 'charts.green' : null;
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
  lines.push('', `status: ${task.status}`);
  if (task.command) lines.push(`command: ${task.command}`, `cwd: ${task.cwd}`);
  if (!task.command && task.openBrowser) lines.push(`opens: ${task.openBrowser}`);
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
    item.tooltip = taskTooltip(t);
    item.contextValue = t.status;
    item.iconPath = taskThemeIcon(t);
    return item;
  }
}

class TaskDragAndDropController {
  constructor(provider) {
    this.provider = provider;
    this.dragMimeTypes = [TASK_DRAG_MIME];
    this.dropMimeTypes = [TASK_DRAG_MIME];
  }

  handleDrag(source, dataTransfer) {
    const tasks = source
      .filter(item => item?.kind === 'task')
      .map(item => ({
        tasksFile: item._project.paths.tasksFile,
        name: item.name,
      }));
    if (tasks.length) dataTransfer.set(TASK_DRAG_MIME, new vscode.DataTransferItem(tasks));
  }

  async handleDrop(target, dataTransfer) {
    const transferItem = dataTransfer.get(TASK_DRAG_MIME);
    if (!transferItem || !target) return;
    let dragged = transferItem.value;
    if (!Array.isArray(dragged)) {
      try { dragged = JSON.parse(await transferItem.asString()); }
      catch { return; }
    }
    if (!Array.isArray(dragged) || dragged.length === 0) return;

    const targetProject = target.kind === 'project' ? target : target._project;
    const tasksFile = targetProject?.paths?.tasksFile;
    if (!tasksFile) return;

    for (const source of dragged) {
      if (source?.tasksFile !== tasksFile || !core.TASK_NAME_RE.test(source?.name || '')) {
        vscode.window.showWarningMessage('taskdev: tasks can only be dragged within the same project');
        continue;
      }
      let destination;
      if (target.kind === 'task') destination = { beforeName: target.name };
      else if (target.kind === 'category') destination = { category: target.name };
      else if (target.kind === 'project') destination = { category: null };
      else continue;

      const result = core.moveTaskTo(tasksFile, source.name, destination);
      if (!result.ok) vscode.window.showWarningMessage(`taskdev: ${result.error}`);
    }
    this.provider.refresh(false);
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
  // A workspace folder is "without config" if no editable TaskDev config
  // exists anywhere in its subtree. A read-only .vscode/tasks.json project can
  // still be shown directly, but this picker should continue to offer creating
  // a taskdev.json for users who want TaskDev-specific metadata.
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

async function addCategoryToTask(elem) {
  if (!elem || elem.kind !== 'task') return;
  const task = core.loadTasks(elem._project.paths.tasksFile).find(item => item.name === elem.name);
  if (!task) return;
  const category = await vscode.window.showInputBox({
    title: 'Add category',
    prompt: 'Enter a category name. Leave empty to remove the current category.',
    value: typeof task.category === 'string' ? task.category : '',
    placeHolder: 'e.g. Extension',
    validateInput(value) {
      const normalized = value.trim();
      if (normalized.length > 64) return 'Category names can contain at most 64 characters.';
      if (/[\r\n]/.test(normalized)) return 'Category names must use a single line.';
      return null;
    },
  });
  if (category === undefined) return;
  const result = core.setTaskCategory(elem._project.paths.tasksFile, elem.name, category);
  if (!result.ok) vscode.window.showWarningMessage(`taskdev: ${result.error}`);
  provider.refresh(false);
}


function activate(ctx) {
  output = vscode.window.createOutputChannel('taskdev');
  ctx.subscriptions.push(output);
  provider = new TreeProvider();
  const treeView = vscode.window.createTreeView('taskdev.tasks', {
    treeDataProvider: provider,
    dragAndDropController: new TaskDragAndDropController(provider),
  });
  ctx.subscriptions.push(provider, treeView);

  // Log viewer: virtual-document provider + refresh emitter.
  _logEmitter = new vscode.EventEmitter();
  ctx.subscriptions.push(
    _logEmitter,
    vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, new LogContentProvider()),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document.uri.scheme === LOG_SCHEME) applyAnsiDecorations(editor.document);
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.uri.scheme !== LOG_SCHEME) return;
      const state = _logDocs.get(logKeyFromUri(doc.uri));
      if (state) disposeLogState(state);
    }),
    // Auto-follow: when the virtual doc's text actually updates, scroll any
    // visible editor to the newest line — unless tail is off.
    vscode.workspace.onDidChangeTextDocument(ev => {
      if (ev.document.uri.scheme !== LOG_SCHEME) return;
      const state = _logDocs.get(logKeyFromUri(ev.document.uri));
      setTimeout(() => {
        applyAnsiDecorations(ev.document);
        if (state && state.tailing) revealNewest(ev.document);
      }, 0);
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('taskdev.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('taskdev.start', elem => {
      if (!elem || elem.kind !== 'task') return;
      const task = core.loadTasks(elem._project.paths.tasksFile).find(x => x.name === elem.name);
      if (!task) return;
      if (!task.command) {
        const url = resolveOpenBrowserUrl(task);
        if (!url) vscode.window.showWarningMessage(`taskdev: invalid browser URL for "${task.name}"`);
        else vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
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
    vscode.commands.registerCommand('taskdev.moveTaskUp', elem => {
      if (!elem || elem.kind !== 'task') return;
      const r = core.moveTask(elem._project.paths.tasksFile, elem.name, 'up');
      if (!r.ok) vscode.window.showWarningMessage(`taskdev: ${r.error}`);
      provider.refresh();
    }),
    vscode.commands.registerCommand('taskdev.moveTaskDown', elem => {
      if (!elem || elem.kind !== 'task') return;
      const r = core.moveTask(elem._project.paths.tasksFile, elem.name, 'down');
      if (!r.ok) vscode.window.showWarningMessage(`taskdev: ${r.error}`);
      provider.refresh();
    }),
    vscode.commands.registerCommand('taskdev.addCategory', addCategoryToTask),
    vscode.commands.registerCommand('taskdev.showLog', showLog),
    vscode.commands.registerCommand('taskdev.toggleLogTail', toggleLogTail),
    vscode.commands.registerCommand('taskdev.setLogFilter', setLogFilter),
    vscode.commands.registerCommand('taskdev.installMcp', installMcpConfig),
    vscode.commands.registerCommand('taskdev.openTasksFile', () => openOrCreateTasksFile(provider)),
    vscode.commands.registerCommand('taskdev.createTasksFile', folderArg => createTasksFileInFolder(provider, folderArg)),
    vscode.commands.registerCommand('taskdev.sendFeedback', () => {
      // Reuses the contact form at taskdev.dev/contact. The ?from query is
      // picked up by site analytics so we can tell extension-driven traffic
      // apart from organic visits.
      vscode.env.openExternal(vscode.Uri.parse('https://taskdev.dev/contact?from=extension'));
    }),
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
    // plus root-level .vscode/tasks.json for read-only VS Code task projects.
    // folder. VS Code's file system watcher delivers OS-level events for
    // matching files only; the recursive glob does not cause any periodic
    // scanning. A matching file appearing or disappearing triggers a single
    // refresh, which re-walks the workspace to update the project list.
    const refresh = () => provider.refresh();
    const taskdevWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(f, '**/{taskdev.json,.taskdev.json}')
    );
    const vscodeTasksWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(f, '.vscode/tasks.json')
    );
    for (const watcher of [taskdevWatcher, vscodeTasksWatcher]) {
      watcher.onDidChange(refresh);
      watcher.onDidCreate(refresh);
      watcher.onDidDelete(refresh);
    }
    const disposable = vscode.Disposable.from(taskdevWatcher, vscodeTasksWatcher);
    watchers.set(f.uri.toString(), disposable);
    ctx.subscriptions.push(disposable);
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
}

function deactivate() {
  for (const type of _ansiDecorationTypes.values()) {
    try { type.dispose(); } catch { /* ignore */ }
  }
  _ansiDecorationTypes.clear();
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

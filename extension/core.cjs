'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const TASK_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function findTasksFile(startDir, stopAt) {
  let d = path.resolve(startDir);
  const stop = stopAt ? path.resolve(stopAt) : null;
  while (true) {
    for (const name of ['taskdev.json', '.taskdev.json']) {
      const c = path.join(d, name);
      if (fs.existsSync(c)) return c;
    }
    if (stop && d === stop) return null;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function pathsFor(tasksFile) {
  const dir = path.dirname(tasksFile);
  const runtime = path.join(dir, '.taskdev');
  return {
    tasksFile,
    stateFile: path.join(runtime, 'state.json'),
    logsDir: path.join(runtime, 'logs'),
  };
}

function ensureRuntimeDirs(paths) {
  fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  return paths;
}

function createTasksFile(tasksFile, projectName) {
  if (!fs.existsSync(tasksFile)) {
    fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
    const config = {
      project: (typeof projectName === 'string' && projectName.trim()) || path.basename(path.dirname(tasksFile)),
      tasks: [],
    };
    const tmp = tasksFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmp, tasksFile);
  }
  return { ok: true, tasksFile, paths: ensureRuntimeDirs(pathsFor(tasksFile)) };
}

function loadConfig(tasksFile) {
  if (!fs.existsSync(tasksFile)) return { tasks: [] };
  try { return JSON.parse(fs.readFileSync(tasksFile, 'utf8')) || { tasks: [] }; }
  catch { return { tasks: [] }; }
}

function loadConfigForWrite(tasksFile) {
  if (!fs.existsSync(tasksFile)) return { ok: true, config: { tasks: [] } };
  try {
    return { ok: true, config: JSON.parse(fs.readFileSync(tasksFile, 'utf8')) || { tasks: [] } };
  } catch (e) {
    return { ok: false, error: `invalid JSON in ${tasksFile}: ${e.message}` };
  }
}

function loadTasks(tasksFile) {
  const data = loadConfig(tasksFile);
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  return tasks.filter(t =>
    t && typeof t.name === 'string' && TASK_NAME_RE.test(t.name) &&
    typeof t.command === 'string' && t.command.length > 0
  );
}

function resolveCwd(tasksFile, task) {
  const base = path.dirname(tasksFile);
  if (!task.cwd) return base;
  return path.isAbsolute(task.cwd) ? task.cwd : path.resolve(base, task.cwd);
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return { tasks: {} };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const raw = s.tasks && typeof s.tasks === 'object' ? s.tasks : {};
    const tasks = {};
    for (const [name, t] of Object.entries(raw)) {
      if (!TASK_NAME_RE.test(name) || !t || typeof t !== 'object') continue;
      const pid = Number(t.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      tasks[name] = {
        ...t,
        pid,
        command: typeof t.command === 'string' ? t.command : '',
        cwd: typeof t.cwd === 'string' ? t.cwd : '',
        startedAt: Number.isFinite(Number(t.startedAt)) ? Number(t.startedAt) : null,
        status: typeof t.status === 'string' ? t.status : 'running',
        source: typeof t.source === 'string' ? t.source : 'taskdev',
      };
    }
    return { tasks };
  } catch { return { tasks: {} }; }
}

function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), tasks: state.tasks }));
  fs.renameSync(tmp, stateFile);
}

function processFingerprint(pid) {
  if (!pid || !Number.isInteger(pid)) return null;
  if (process.platform === 'win32') {
    const r = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status === 0) {
      const match = r.stdout.match(/CreationDate=([^\s\r\n]+)/);
      if (match) return match[1];
    }
    const ps = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToFileTimeUtc()`,
    ], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return ps.status === 0 && ps.stdout.trim() ? ps.stdout.trim() : null;
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      if (end < 0) return null;
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      return fields[19] || null;
    } catch {
      return null;
    }
  }
  return null;
}

function isAlive(pidOrEntry) {
  const pid = typeof pidOrEntry === 'object' ? pidOrEntry?.pid : pidOrEntry;
  if (!pid || !Number.isInteger(pid)) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout.includes(`"${pid}"`)) return false;
  } else {
    try { process.kill(pid, 0); } catch { return false; }
  }
  if (typeof pidOrEntry === 'object' && pidOrEntry?.processFingerprint) {
    const current = processFingerprint(pid);
    if (current && current !== pidOrEntry.processFingerprint) return false;
  }
  return true;
}

function reconcile(state) {
  let changed = false;
  for (const [name, t] of Object.entries(state.tasks || {})) {
    if (!t?.pid || !isAlive(t)) { delete state.tasks[name]; changed = true; }
  }
  return { state, changed };
}

const LOG_ROTATE_BYTES = 50 * 1024 * 1024;
const ENV_DENYLIST = /^(PATH|PATHEXT|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|NODE_OPTIONS)$/i;
const SAFE_COMMAND_RE = /^[A-Za-z0-9_./:@%+=,\-\\ "']+$/;
const BLOCKED_COMMANDS_BY_OS = {
  common: [
    'curl', 'docker', 'ftp', 'git', 'java', 'javac', 'jar', 'kubectl', 'helm',
    'node', 'npx', 'perl', 'php', 'podman', 'python', 'python3', 'ruby', 'scp',
    'ssh', 'telnet', 'wget',
  ],
  linux: [
    'apk', 'apt', 'apt-get', 'bash', 'busybox', 'chmod', 'chown', 'crontab',
    'dd', 'dnf', 'doas', 'kill', 'killall', 'lua', 'mkfs', 'mount', 'nc',
    'ncat', 'netcat', 'pacman', 'pkill', 'reboot', 'rm', 'rmdir', 'rsync',
    'service', 'sh', 'shutdown', 'shred', 'socat', 'su', 'sudo', 'systemctl',
    'umount', 'yum', 'zypper',
  ],
  macos: [
    'brew', 'defaults', 'diskutil', 'hdiutil', 'launchctl', 'open', 'osascript',
    'plutil', 'swift', 'swiftc',
  ],
  windows: [
    'bitsadmin', 'certutil', 'choco', 'cmd', 'copy', 'cscript', 'del', 'erase',
    'format', 'icacls', 'move', 'mshta', 'msiexec', 'net', 'netsh',
    'powershell', 'pwsh', 'rd', 'reg', 'regsvr32', 'robocopy', 'rundll32',
    'scoop', 'schtasks', 'sc', 'setx', 'takeown', 'taskkill', 'winget', 'wscript',
    'wsl', 'wsl.exe', 'xcopy',
  ],
};
const COMMAND_DENYLIST_RE = new RegExp(
  `\\b(${Object.values(BLOCKED_COMMANDS_BY_OS).flat().map(escapeRegExp).join('|')})\\b`,
  'i',
);
const COMMAND_CHAIN_RE = /[;&|<>$()\n\r]/;
const ALLOWED_COMMAND_PREFIXES = [
  /^npm\s+run\s+[A-Za-z0-9_.:-]+(?:\s+--(?:\s+[A-Za-z0-9_./:@%+=,\-]+)*)?$/i,
  /^pnpm\s+run\s+[A-Za-z0-9_.:-]+(?:\s+--(?:\s+[A-Za-z0-9_./:@%+=,\-]+)*)?$/i,
  /^yarn\s+(?:run\s+)?[A-Za-z0-9_.:-]+(?:\s+--(?:\s+[A-Za-z0-9_./:@%+=,\-]+)*)?$/i,
  /^dotnet\s+(?:run|watch|test|build)(?:\s+[A-Za-z0-9_./:@%+=,\-]+)*$/i,
  /^cargo\s+(?:run|test|build|watch)(?:\s+[A-Za-z0-9_./:@%+=,\-]+)*$/i,
  /^go\s+(?:run|test|build)(?:\s+[A-Za-z0-9_./:@%+=,\-]+)*$/i,
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTokenQuotes(token) {
  return token.replace(/^["']|["']$/g, '');
}

function tokenPathValue(token) {
  const value = stripTokenQuotes(token);
  const eq = value.indexOf('=');
  return eq >= 0 ? value.slice(eq + 1) : value;
}

function hasPathTraversalSegment(value) {
  return value.split(/[\\/]+/).includes('..');
}

function isOutsideWorkspacePath(value, workspaceDir) {
  const candidate = tokenPathValue(value);
  if (!candidate || candidate.startsWith('-')) return false;
  if (hasPathTraversalSegment(candidate)) return true;
  if (!/[\\/]/.test(candidate)) return false;
  if (path.isAbsolute(candidate)) {
    const rel = path.relative(workspaceDir, candidate);
    return rel.startsWith('..') || path.isAbsolute(rel);
  }
  return false;
}

function sanitizeEnv(taskEnv) {
  const out = {};
  const blocked = [];
  for (const [k, v] of Object.entries(taskEnv || {})) {
    if (ENV_DENYLIST.test(k)) blocked.push(k); else out[k] = v;
  }
  return { env: out, blocked };
}

function validateTaskCommand(command, tasksFile) {
  if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'command is required' };
  const trimmed = command.trim();
  const workspaceDir = path.dirname(tasksFile || process.cwd());
  if (trimmed.length > 300) return { ok: false, error: 'command too long' };
  if (!SAFE_COMMAND_RE.test(trimmed)) return { ok: false, error: 'command contains unsupported characters' };
  if (COMMAND_CHAIN_RE.test(trimmed)) return { ok: false, error: 'command chaining, redirects, variables, and subshells are not allowed' };
  if (COMMAND_DENYLIST_RE.test(trimmed)) return { ok: false, error: 'command uses a blocked executable' };
  if (!ALLOWED_COMMAND_PREFIXES.some(re => re.test(trimmed))) {
    return { ok: false, error: 'command must use an allowed dev-task prefix such as npm run, dotnet run/build/test, cargo, or go' };
  }
  if (trimmed.split(/\s+/).some(token => isOutsideWorkspacePath(token, workspaceDir))) {
    return { ok: false, error: 'command arguments must not reference paths outside the project' };
  }
  return { ok: true, command: trimmed };
}

function validateNewTask(task, tasksFile) {
  if (!task || typeof task !== 'object') return { ok: false, error: 'task object is required' };
  if (!TASK_NAME_RE.test(task.name || '')) return { ok: false, error: 'invalid task name' };
  const command = validateTaskCommand(task.command, tasksFile);
  if (!command.ok) return command;
  if (task.cwd !== undefined && typeof task.cwd !== 'string') return { ok: false, error: 'cwd must be a string' };
  if (task.cwd) {
    const resolved = resolveCwd(tasksFile, task);
    const base = path.dirname(tasksFile);
    const rel = path.relative(base, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'cwd must stay inside the project' };
  }
  if (task.env !== undefined && (typeof task.env !== 'object' || Array.isArray(task.env) || task.env === null)) {
    return { ok: false, error: 'env must be an object' };
  }
  const { blocked } = sanitizeEnv(task.env);
  if (blocked.length) return { ok: false, error: `blocked env keys: ${blocked.join(', ')}` };
  return {
    ok: true,
    task: {
      name: task.name,
      command: command.command,
      ...(task.cwd ? { cwd: task.cwd } : {}),
      ...(task.env && Object.keys(task.env).length ? { env: task.env } : {}),
    },
  };
}

function addTask(tasksFile, task, options = {}) {
  if (options.confirm !== `ADD ${task?.name || ''}`) {
    return { ok: false, error: `confirmation required: pass confirm: "ADD ${task?.name || '<name>'}"` };
  }
  const valid = validateNewTask(task, tasksFile);
  if (!valid.ok) return valid;
  const loaded = loadConfigForWrite(tasksFile);
  if (!loaded.ok) return loaded;
  const config = loaded.config;
  if (!Array.isArray(config.tasks)) config.tasks = [];
  if (config.tasks.some(t => t?.name === valid.task.name)) return { ok: false, error: 'task already exists' };
  config.tasks.push(valid.task);
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  const tmp = tasksFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, tasksFile);
  return { ok: true, task: valid.task, tasksFile };
}

function removeTask(tasksFile, name, options = {}) {
  if (options.confirm !== `REMOVE ${name || ''}`) {
    return { ok: false, error: `confirmation required: pass confirm: "REMOVE ${name || '<name>'}"` };
  }
  if (!TASK_NAME_RE.test(name || '')) return { ok: false, error: 'invalid task name' };
  const paths = pathsFor(tasksFile);
  const { state } = reconcile(readState(paths.stateFile));
  if (state.tasks[name]?.pid) return { ok: false, error: 'task is running; stop it before removing' };
  const loaded = loadConfigForWrite(tasksFile);
  if (!loaded.ok) return loaded;
  const config = loaded.config;
  if (!Array.isArray(config.tasks)) config.tasks = [];
  const index = config.tasks.findIndex(t => t?.name === name);
  if (index < 0) return { ok: false, error: 'unknown task' };
  const [task] = config.tasks.splice(index, 1);
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  const tmp = tasksFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, tasksFile);
  return { ok: true, task, tasksFile };
}

function acquireLock(lockFile) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > 30000) { try { fs.unlinkSync(lockFile); } catch {} continue; }
      } catch {}
      if (Date.now() > deadline) return false;
      const end = Date.now() + 50; while (Date.now() < end) {}
    }
  }
}

function releaseLock(lockFile) { try { fs.unlinkSync(lockFile); } catch {} }

function withStateLock(stateFile, fn) {
  const lockFile = stateFile + '.lock';
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  if (!acquireLock(lockFile)) return { ok: false, error: 'state busy' };
  try { return fn(); } finally { releaseLock(lockFile); }
}

function rotateLogIfNeeded(logPath) {
  try {
    const st = fs.statSync(logPath);
    if (st.size > LOG_ROTATE_BYTES) {
      const rotated = logPath + '.1';
      try { fs.unlinkSync(rotated); } catch {}
      fs.renameSync(logPath, rotated);
    }
  } catch {}
}

function logPathFor(paths, name) {
  if (!TASK_NAME_RE.test(name)) throw new Error('invalid task name');
  return path.join(paths.logsDir, `${name}.log`);
}

function appendLog(logPath, message) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, message);
}

function startTask(task, paths) {
  if (!TASK_NAME_RE.test(task.name)) return { ok: false, error: 'invalid task name' };
  return withStateLock(paths.stateFile, () => _startTaskLocked(task, paths));
}

function _startTaskLocked(task, paths) {
  const { state } = reconcile(readState(paths.stateFile));
  if (state.tasks[task.name]?.pid) {
    const running = state.tasks[task.name];
    return {
      ok: true,
      status: 'running',
      alreadyRunning: true,
      pid: running.pid,
      logPath: running.logPath || logPathFor(paths, task.name),
    };
  }
  const cwd = resolveCwd(paths.tasksFile, task);
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const logPath = logPathFor(paths, task.name);
  rotateLogIfNeeded(logPath);
  const fd = fs.openSync(logPath, 'a');
  const { env: safeEnv, blocked } = sanitizeEnv(task.env);
  fs.writeSync(fd, `\n[${new Date().toISOString()}] start: ${task.command} (cwd=${cwd})\n`);
  if (blocked.length) fs.writeSync(fd, `[taskdev] blocked env keys: ${blocked.join(', ')}\n`);
  fs.closeSync(fd);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  let child;
  try {
    child = spawn(task.command, {
      cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...safeEnv },
    });
  } catch (e) {
    logStream.end();
    return { ok: false, error: e.message };
  }
  child.stdout?.on('data', chunk => logStream.write(chunk));
  child.stderr?.on('data', chunk => logStream.write(chunk));
  child.on('error', e => {
    logStream.write(`[${new Date().toISOString()}] error: ${e.message}\n`);
    logStream.end();
  });
  child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    logStream.write(`[${new Date().toISOString()}] exit: ${reason}\n`);
    logStream.end();
  });
  const pid = child.pid;
  if (!pid) {
    logStream.end();
    return { ok: false, error: 'spawn failed' };
  }
  state.tasks[task.name] = {
    pid,
    command: task.command,
    cwd,
    startedAt: Date.now(),
    processFingerprint: processFingerprint(pid),
    status: 'running',
    source: 'taskdev',
    logPath,
  };
  writeState(paths.stateFile, state);
  return { ok: true, status: 'running', pid, logPath };
}

function stopTask(name, paths) {
  if (!TASK_NAME_RE.test(name)) return { ok: false, error: 'invalid task name' };
  return withStateLock(paths.stateFile, () => _stopTaskLocked(name, paths));
}

function _stopTaskLocked(name, paths) {
  const { state } = reconcile(readState(paths.stateFile));
  const entry = state.tasks[name];
  if (!entry?.pid) { writeState(paths.stateFile, state); return { ok: false, error: 'not running' }; }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(entry.pid)], { windowsHide: true });
  } else {
    try { process.kill(-entry.pid, 'SIGTERM'); }
    catch {
      try { process.kill(entry.pid, 'SIGTERM'); } catch {}
    }
  }
  if (entry.logPath) appendLog(entry.logPath, `[${new Date().toISOString()}] stop requested for pid ${entry.pid}\n`);
  delete state.tasks[name];
  writeState(paths.stateFile, state);
  return { ok: true };
}

function restartTask(task, paths) {
  stopTask(task.name, paths);
  return startTask(task, paths);
}

function listTasks(paths, options = {}) {
  const tasks = loadTasks(paths.tasksFile);
  let state = readState(paths.stateFile);
  if (options.reconcile !== false) {
    const result = reconcile(state);
    state = result.state;
    if (result.changed) { try { writeState(paths.stateFile, state); } catch { /* ignore */ } }
  }
  const now = Date.now();
  return tasks.map(t => {
    const e = state.tasks[t.name];
    return {
      name: t.name,
      command: t.command,
      cwd: resolveCwd(paths.tasksFile, t),
      pid: e?.pid ?? null,
      status: e?.pid ? 'running' : 'stopped',
      startedAt: e?.startedAt ?? null,
      uptimeMs: e?.startedAt ? now - e.startedAt : null,
      source: e?.source ?? null,
      logPath: e?.logPath ?? logPathFor(paths, t.name),
      type: typeof t.type === 'string' ? t.type : null,
      detail: typeof t.detail === 'string' ? t.detail : null,
      icon: typeof t.icon === 'string' || (t.icon && typeof t.icon === 'object') ? t.icon : null,
    };
  });
}

function tailLog(paths, name, lines = 100) {
  if (!TASK_NAME_RE.test(name)) return { ok: false, error: 'invalid task name' };
  const logPath = logPathFor(paths, name);
  const rel = path.relative(paths.logsDir, logPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'invalid name' };
  if (!fs.existsSync(logPath)) return { ok: false, error: 'no log file found' };
  const stat = fs.statSync(logPath);
  const cap = 256 * 1024;
  const start = Math.max(0, stat.size - cap);
  const len = stat.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(logPath, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  return { ok: true, text: buf.toString('utf8').split('\n').slice(-lines).join('\n'), logPath };
}

module.exports = {
  TASK_NAME_RE, findTasksFile,
  pathsFor, ensureRuntimeDirs, createTasksFile, loadConfig, loadTasks, resolveCwd,
  readState, writeState, isAlive, processFingerprint, reconcile, startTask, stopTask, restartTask, listTasks,
  logPathFor, tailLog, validateTaskCommand, validateNewTask, addTask, removeTask, loadConfigForWrite,
};

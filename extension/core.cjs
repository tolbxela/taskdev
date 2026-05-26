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

// Tracks whether the Windows `wmic` command exists. wmic was deprecated and
// removed in Windows 11 24H2; on those systems we must NOT fall back to
// powershell, because a powershell cold start is 1–3 seconds and we call this
// during `startTask` while holding the state lock. Once we've learned that
// wmic is unavailable, return null immediately on subsequent calls.
//   null   -> unknown (probe once)
//   true   -> wmic spawns succeed
//   false  -> wmic missing or unusable, skip fingerprinting on this host
let WMIC_AVAILABLE = null;

function processFingerprint(pid) {
  if (!pid || !Number.isInteger(pid)) return null;
  if (process.platform === 'win32') {
    if (WMIC_AVAILABLE === false) return null;
    const r = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.error && r.error.code === 'ENOENT') {
      WMIC_AVAILABLE = false;
      return null;
    }
    if (r.status === 0) {
      WMIC_AVAILABLE = true;
      const match = r.stdout.match(/CreationDate=([^\s\r\n]+)/);
      if (match) return match[1];
    }
    // wmic exited non-zero (e.g. unknown PID). Don't pay for a powershell
    // cold start; fall back to PID-alive checks only.
    return null;
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

// Quick existence check that avoids spawning a child process. On Windows this
// goes through libuv's OpenProcess path; on POSIX it sends signal 0.
//   ESRCH  -> process does not exist
//   EPERM  -> process exists, we just can't signal it (treat as alive)
function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

// PIDs whose stored processFingerprint we've already verified during this
// process's lifetime. `isAlive` skips the (expensive) wmic/powershell call on
// subsequent reconciles for the same PID, which is the dominant cost on
// Windows. Once a PID disappears the cache entry is dropped so reuse by a
// brand-new task still gets verified on its first reconcile.
const VERIFIED_FINGERPRINT_PIDS = new Map(); // pid -> fingerprint string

function _clearVerifiedFingerprintCache() {
  VERIFIED_FINGERPRINT_PIDS.clear();
}

function _verifiedFingerprintCacheSize() {
  return VERIFIED_FINGERPRINT_PIDS.size;
}

function isAlive(pidOrEntry) {
  const pid = typeof pidOrEntry === 'object' ? pidOrEntry?.pid : pidOrEntry;
  if (!pid || !Number.isInteger(pid)) return false;
  if (!pidAlive(pid)) {
    VERIFIED_FINGERPRINT_PIDS.delete(pid);
    return false;
  }
  if (typeof pidOrEntry === 'object' && pidOrEntry?.processFingerprint) {
    const cached = VERIFIED_FINGERPRINT_PIDS.get(pid);
    if (cached === pidOrEntry.processFingerprint) return true;
    const current = processFingerprint(pid);
    if (current && current !== pidOrEntry.processFingerprint) {
      VERIFIED_FINGERPRINT_PIDS.delete(pid);
      return false;
    }
    // Either the fingerprint matched, or we couldn't read one (e.g. wmic is
    // gone and powershell failed). In the latter case we fall back to trust
    // by PID liveness alone, which is what the POSIX path also does.
    VERIFIED_FINGERPRINT_PIDS.set(pid, pidOrEntry.processFingerprint);
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

const LOG_HISTORY_KEEP = 20;
const LOG_FILE_RE = /^(.+)\.(\d{8}T\d{6}\d{3}Z)\.log$/;
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

function timestampSlug(date) {
  const iso = (date || new Date()).toISOString();
  return iso.replace(/[-:]/g, '').replace('.', '');
}

function logPathFor(paths, name) {
  if (!TASK_NAME_RE.test(name)) throw new Error('invalid task name');
  return path.join(paths.logsDir, `${name}.log`);
}

function newLogPath(paths, name, date) {
  if (!TASK_NAME_RE.test(name)) throw new Error('invalid task name');
  return path.join(paths.logsDir, `${name}.${timestampSlug(date)}.log`);
}

function listLogFiles(paths, name) {
  if (!TASK_NAME_RE.test(name)) return [];
  let entries;
  try { entries = fs.readdirSync(paths.logsDir); } catch { return []; }
  const out = [];
  for (const file of entries) {
    const m = LOG_FILE_RE.exec(file);
    if (!m || m[1] !== name) continue;
    const full = path.join(paths.logsDir, file);
    let stat; try { stat = fs.statSync(full); } catch { continue; }
    out.push({ file, path: full, size: stat.size, mtimeMs: stat.mtimeMs, startedAt: m[2] });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function pruneOldLogs(paths, name, keep = LOG_HISTORY_KEEP) {
  const files = listLogFiles(paths, name);
  for (const f of files.slice(keep)) {
    try { fs.unlinkSync(f.path); } catch {}
  }
}

function currentLogPath(paths, name) {
  if (!TASK_NAME_RE.test(name)) return null;
  const state = readState(paths.stateFile);
  const stateLog = state.tasks?.[name]?.logPath;
  if (stateLog && fs.existsSync(stateLog)) return stateLog;
  const files = listLogFiles(paths, name);
  if (files.length) return files[0].path;
  const legacy = logPathFor(paths, name);
  return fs.existsSync(legacy) ? legacy : null;
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
      logPath: running.logPath || currentLogPath(paths, task.name) || logPathFor(paths, task.name),
    };
  }
  const cwd = resolveCwd(paths.tasksFile, task);
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const logPath = newLogPath(paths, task.name);
  pruneOldLogs(paths, task.name);
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
      logPath: e?.logPath ?? currentLogPath(paths, t.name) ?? logPathFor(paths, t.name),
      type: typeof t.type === 'string' ? t.type : null,
      detail: typeof t.detail === 'string' ? t.detail : null,
      icon: typeof t.icon === 'string' || (t.icon && typeof t.icon === 'object') ? t.icon : null,
      category: typeof t.category === 'string' && t.category.trim() ? t.category.trim() : null,
    };
  });
}

function resolveLogPath(paths, name, file) {
  if (!TASK_NAME_RE.test(name)) return { ok: false, error: 'invalid task name' };
  let logPath;
  if (file) {
    if (typeof file !== 'string' || file.includes('/') || file.includes('\\') || file.includes('..')) {
      return { ok: false, error: 'invalid file' };
    }
    const m = LOG_FILE_RE.exec(file);
    if (!m || m[1] !== name) return { ok: false, error: 'file does not belong to task' };
    logPath = path.join(paths.logsDir, file);
  } else {
    logPath = currentLogPath(paths, name);
    if (!logPath) return { ok: false, error: 'no log file found' };
  }
  const rel = path.relative(paths.logsDir, logPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'invalid path' };
  if (!fs.existsSync(logPath)) return { ok: false, error: 'no log file found' };
  return { ok: true, logPath };
}

// Default read window when slicing the tail of a log. Large enough to capture
// hundreds of typical lines, small enough that single reads stay cheap.
const TAIL_READ_DEFAULT_BYTES = 64 * 1024;
const TAIL_READ_MAX_BYTES = 256 * 1024;

// Read the tail of a log file, bounded by both a line cap and a byte budget.
// Callers (the MCP tool, the extension's own log resource) use the returned
// metadata to decide whether to show a "log truncated" hint to the user.
//
// Parameters:
//   lines  - soft line cap (default 100).
//   bytes  - window size in bytes (default TAIL_READ_DEFAULT_BYTES, clamped
//            to TAIL_READ_MAX_BYTES).
//
// Returns (on success):
//   text           - decoded UTF-8 tail; partial first line is dropped when
//                    older content exists so callers only see whole records.
//   logSize        - total file size in bytes
//   returnedBytes  - Buffer.byteLength(text)
//   truncated      - true when older content was dropped to fit the budget
function tailLog(paths, name, lines = 100, file, bytes) {
  const resolved = resolveLogPath(paths, name, file);
  if (!resolved.ok) return resolved;
  const { logPath } = resolved;
  const stat = fs.statSync(logPath);
  const requested = Number.isFinite(Number(bytes)) ? Number(bytes) : TAIL_READ_DEFAULT_BYTES;
  const cap = Math.max(1024, Math.min(TAIL_READ_MAX_BYTES, requested));
  const windowStart = Math.max(0, stat.size - cap);
  const len = stat.size - windowStart;
  const buf = Buffer.alloc(len);
  if (len > 0) {
    const fd = fs.openSync(logPath, 'r');
    try { fs.readSync(fd, buf, 0, len, windowStart); } finally { fs.closeSync(fd); }
  }
  let text = buf.toString('utf8');
  // If we started mid-file, the first "line" is partial. Drop it so callers
  // never see half a record.
  if (windowStart > 0) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
  }
  // Apply the soft line cap.
  const lineCap = Math.max(1, Math.min(Number(lines) || 100, 5000));
  const split = text.split('\n');
  text = split.slice(-lineCap).join('\n');
  // Even with the line cap, the result could exceed the byte budget if lines
  // are very long. Trim from the front, keeping line boundaries.
  let textBytes = Buffer.byteLength(text, 'utf8');
  if (textBytes > cap) {
    const overflow = textBytes - cap;
    const sliced = Buffer.from(text, 'utf8').slice(overflow).toString('utf8');
    const nl = sliced.indexOf('\n');
    text = nl >= 0 ? sliced.slice(nl + 1) : sliced;
    textBytes = Buffer.byteLength(text, 'utf8');
  }
  return {
    ok: true,
    text,
    logPath,
    logSize: stat.size,
    returnedBytes: textBytes,
    truncated: textBytes < stat.size,
  };
}

function logHistory(paths, name) {
  if (!TASK_NAME_RE.test(name)) return { ok: false, error: 'invalid task name' };
  const files = listLogFiles(paths, name);
  return {
    ok: true,
    logs: files.map(f => ({
      file: f.file,
      path: f.path,
      size: f.size,
      mtime: new Date(f.mtimeMs).toISOString(),
    })),
  };
}

// Project name. Allows '/' so a relative path inside a workspace folder
// (e.g. "apps/web") can be used as a fallback display name when the
// taskdev.json does not set "project" explicitly.
const PROJECT_NAME_RE = /^[A-Za-z0-9_.\- /]{1,64}$/;

function sanitizeProjectName(name, fallback) {
  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (trimmed && PROJECT_NAME_RE.test(trimmed)) return trimmed;
  }
  return fallback;
}

// Directory names that are always skipped when walking a workspace looking
// for taskdev.json files. These are the usual suspects that hold thousands
// of files we don't care about. Excludes are matched by exact directory
// name (not glob), which keeps the walker dependency-free and fast.
const SCAN_EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn',
  'node_modules',
  '.taskdev',           // our own runtime dir
  '.vscode', '.idea',
  'bin', 'obj',          // .NET
  'dist', 'build', 'out',
  'target',              // Rust / Java
  '.next', '.nuxt', '.svelte-kit', '.astro', '.angular', '.parcel-cache',
  '.cache', '.turbo', '.vercel', '.netlify',
  'coverage', '.nyc_output',
  '__pycache__', '.venv', 'venv', '.tox', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'vendor',              // Go / PHP
  'Pods',                // CocoaPods
  'DerivedData',         // Xcode
]);

// Cap to keep a pathological workspace (think: untracked monorepo with
// generated configs) from making us walk forever. Far above any realistic
// number of task files in a single project tree.
const SCAN_MAX_RESULTS = 64;
const SCAN_MAX_DEPTH = 8;

// Synchronous BFS for taskdev.json / .taskdev.json under `root`. Returns
// absolute file paths in deterministic order (sorted within each directory).
// Cost is O(visited directories); excluded subtrees are not entered at all.
function scanForTasksFiles(root, opts) {
  const startDir = path.resolve(root);
  if (!fs.existsSync(startDir)) return [];
  const extraExcludes = opts && Array.isArray(opts.extraExcludes)
    ? new Set(opts.extraExcludes.filter(s => typeof s === 'string' && s))
    : null;
  const maxResults = (opts && opts.maxResults) || SCAN_MAX_RESULTS;
  const maxDepth = (opts && typeof opts.maxDepth === 'number') ? opts.maxDepth : SCAN_MAX_DEPTH;

  const found = [];
  const queue = [{ dir: startDir, depth: 0 }];
  while (queue.length && found.length < maxResults) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    // Files first: if this directory has a task file, record it and stop
    // descending here. Nesting a taskdev.json inside another project's
    // subtree is not supported - the parent owns this folder.
    let hit = null;
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name === 'taskdev.json' || e.name === '.taskdev.json') {
        hit = path.join(dir, e.name);
        break;
      }
    }
    if (hit) {
      found.push(hit);
      continue;
    }

    if (depth >= maxDepth) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Skip symlinks to avoid loops and to keep behavior predictable.
      if (e.isSymbolicLink && e.isSymbolicLink()) continue;
      const name = e.name;
      if (name.startsWith('.') && SCAN_EXCLUDED_DIRS.has(name)) {
        // dotted dirs we explicitly exclude (e.g. .git, .next)
        continue;
      }
      if (SCAN_EXCLUDED_DIRS.has(name)) continue;
      if (extraExcludes && extraExcludes.has(name)) continue;
      queue.push({ dir: path.join(dir, name), depth: depth + 1 });
    }
  }
  return found;
}

function discoverProjects(roots, opts) {
  const list = Array.isArray(roots) ? roots : [];
  const seen = new Set();
  const projects = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const root = path.resolve(raw);
    const files = scanForTasksFiles(root, opts);
    for (const tasksFile of files) {
      if (seen.has(tasksFile)) continue;
      seen.add(tasksFile);
      const cfg = loadConfig(tasksFile);
      const folder = path.basename(path.dirname(tasksFile));
      const rel = path.relative(root, path.dirname(tasksFile));
      // Fallback name: relative path inside the workspace folder, which
      // disambiguates monorepos out of the box ("apps/web" vs "web"). Pure
      // root-level configs keep the folder name so existing setups don't
      // suddenly get renamed.
      const fallback = !rel || rel === '.' ? folder : rel.split(path.sep).join('/');
      const name = sanitizeProjectName(cfg.project, fallback);
      projects.push({ name, root, tasksFile, paths: pathsFor(tasksFile) });
    }
  }
  // Disambiguate duplicate names by appending " (folder)".
  const counts = new Map();
  for (const p of projects) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  for (const p of projects) {
    if (counts.get(p.name) > 1) {
      const folder = path.basename(path.dirname(p.tasksFile));
      if (folder !== p.name) p.name = `${p.name} (${folder})`;
    }
  }
  return projects;
}

module.exports = {
  TASK_NAME_RE, PROJECT_NAME_RE, findTasksFile,
  pathsFor, ensureRuntimeDirs, createTasksFile, loadConfig, loadTasks, resolveCwd,
  readState, writeState, isAlive, pidAlive, processFingerprint, reconcile, startTask, stopTask, restartTask, listTasks,
  logPathFor, newLogPath, currentLogPath, listLogFiles, logHistory,
  tailLog, TAIL_READ_DEFAULT_BYTES, TAIL_READ_MAX_BYTES,
  validateTaskCommand, validateNewTask, addTask, removeTask, loadConfigForWrite,
  discoverProjects, sanitizeProjectName, scanForTasksFiles, SCAN_EXCLUDED_DIRS,
  _clearVerifiedFingerprintCache, _verifiedFingerprintCacheSize,
};

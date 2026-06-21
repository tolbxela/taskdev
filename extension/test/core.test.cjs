'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../core.cjs');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

{
  const terminalText =
    '\u001b[2m14:50:25\u001b[22m \u001b[34m[vite]\u001b[39m connected.\r' +
    '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u0000';
  const parsed = core.parseTerminalText(terminalText);
  assert.equal(parsed.text, '14:50:25 [vite] connected.link');
  assert.deepEqual(parsed.spans, [
    { start: 0, end: 8, style: { dim: true } },
    { start: 9, end: 15, style: { fg: 'ansiBlue' } },
  ]);
  assert.equal(core.stripTerminalSequences(terminalText), parsed.text);
  const color = core.parseTerminalText('\u001b[38;5;196mred\u001b[0m \u001b[48;2;1;2;3mtrue\u001b[0m');
  assert.equal(color.text, 'red true');
  assert.deepEqual(color.spans, [
    { start: 0, end: 3, style: { fg: '#ff0000' } },
    { start: 4, end: 8, style: { bg: '#010203' } },
  ]);
  assert.equal(core.stripTerminalSequences('plain text'), 'plain text');
}

function withTempProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdev-test-'));
  const tasksFile = path.join(dir, 'taskdev.json');
  fs.writeFileSync(tasksFile, JSON.stringify({ project: 'Test', tasks: [] }, null, 2));
  try {
    fn({ dir, tasksFile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function withTempProjectAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdev-test-'));
  const tasksFile = path.join(dir, 'taskdev.json');
  fs.writeFileSync(tasksFile, JSON.stringify({ project: 'Test', tasks: [] }, null, 2));
  try {
    await fn({ dir, tasksFile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

withTempProject(({ tasksFile }) => {
  const paths = core.pathsFor(tasksFile);
  assert.equal(fs.existsSync(path.join(path.dirname(tasksFile), '.taskdev')), false);

  const ensured = core.ensureRuntimeDirs(paths);
  assert.equal(ensured, paths);
  assert.equal(fs.statSync(path.join(path.dirname(tasksFile), '.taskdev')).isDirectory(), true);
  assert.equal(fs.statSync(paths.logsDir).isDirectory(), true);
});

withTempProject(({ dir }) => {
  const tasksFile = path.join(dir, 'nested', 'taskdev.json');
  const created = core.createTasksFile(tasksFile, 'Nested Project');

  assert.equal(created.ok, true);
  assert.equal(created.tasksFile, tasksFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(tasksFile, 'utf8')), {
    project: 'Nested Project',
    tasks: [
      {
        name: 'taskdev-home',
        openBrowser: 'https://taskdev.dev',
      },
      {
        name: 'taskdev-contact',
        openBrowser: 'https://taskdev.dev/contact',
      },
    ],
  });
  assert.equal(fs.statSync(path.join(dir, 'nested', '.taskdev')).isDirectory(), true);
  assert.equal(fs.statSync(created.paths.logsDir).isDirectory(), true);
});

// discoverProjects: multi-root, name from config or folder, dedup, disambiguation.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdev-multi-'));
  try {
    const a = path.join(root, 'alpha');
    const b = path.join(root, 'beta');
    const c = path.join(root, 'gamma');
    const d = path.join(root, 'delta');
    fs.mkdirSync(a); fs.mkdirSync(b); fs.mkdirSync(c); fs.mkdirSync(d);
    fs.writeFileSync(path.join(a, 'taskdev.json'), JSON.stringify({ project: 'AlphaApp', tasks: [] }));
    fs.writeFileSync(path.join(b, 'taskdev.json'), JSON.stringify({ tasks: [] })); // no project name -> folder
    fs.writeFileSync(path.join(c, 'taskdev.json'), JSON.stringify({ project: 'Shared', tasks: [] }));
    fs.writeFileSync(path.join(d, 'taskdev.json'), JSON.stringify({ project: 'Shared', tasks: [] }));
    // no taskdev.json in 'epsilon'
    const epsilon = path.join(root, 'epsilon');
    fs.mkdirSync(epsilon);

    const projects = core.discoverProjects([a, b, c, d, epsilon, a /* dup */]);
    assert.equal(projects.length, 4);
    const byName = Object.fromEntries(projects.map(p => [p.name, p]));
    assert.ok(byName['AlphaApp']);
    assert.ok(byName['beta']);
    // collision: both 'Shared' get disambiguated.
    assert.equal(projects.filter(p => p.name === 'Shared').length, 0);
    assert.equal(projects.filter(p => p.name.startsWith('Shared (')).length, 2);

    // empty / bogus inputs return empty.
    assert.deepEqual(core.discoverProjects([]), []);
    assert.deepEqual(core.discoverProjects(['', null, undefined]), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// discoverProjects: subtree discovery, exclude dirs, nested project naming.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdev-subtree-'));
  try {
    // apps/web: has named project
    fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'apps', 'web', 'taskdev.json'),
      JSON.stringify({ project: 'Web', tasks: [] }),
    );
    // services/api: no project field -> fallback to relative path
    fs.mkdirSync(path.join(root, 'services', 'api'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'services', 'api', 'taskdev.json'),
      JSON.stringify({ tasks: [] }),
    );
    // node_modules/whatever/taskdev.json must be ignored.
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'node_modules', 'pkg', 'taskdev.json'),
      JSON.stringify({ project: 'ShouldBeIgnored', tasks: [] }),
    );
    // .git/taskdev.json must be ignored.
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.git', 'taskdev.json'),
      JSON.stringify({ project: 'AlsoIgnored', tasks: [] }),
    );
    // bin and obj under a nested project: ignored.
    fs.mkdirSync(path.join(root, 'apps', 'api', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'apps', 'api', 'bin', 'taskdev.json'),
      JSON.stringify({ project: 'BinJunk', tasks: [] }),
    );
    fs.mkdirSync(path.join(root, 'apps', 'api', 'obj'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'apps', 'api', 'obj', 'taskdev.json'),
      JSON.stringify({ project: 'ObjJunk', tasks: [] }),
    );

    const projects = core.discoverProjects([root]);
    const names = projects.map(p => p.name).sort();
    assert.deepEqual(names, ['Web', 'services/api'],
      'expected only the two real nested projects; node_modules / .git / bin / obj must be excluded');

    // scanForTasksFiles exposed for the extension's foldersWithoutConfig helper.
    const files = core.scanForTasksFiles(root);
    assert.equal(files.length, 2, 'scanner finds same two files');
    assert.ok(files.every(f => f.endsWith('taskdev.json')));

    // maxResults short-circuits.
    const truncated = core.scanForTasksFiles(root, { maxResults: 1 });
    assert.equal(truncated.length, 1);

    // Nesting: a taskdev.json INSIDE another project's subtree is not picked
    // up. The outer one wins.
    fs.mkdirSync(path.join(root, 'apps', 'web', 'subapp'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'apps', 'web', 'subapp', 'taskdev.json'),
      JSON.stringify({ project: 'Inner', tasks: [] }),
    );
    const afterNesting = core.discoverProjects([root]).map(p => p.name).sort();
    assert.deepEqual(afterNesting, ['Web', 'services/api'],
      'a nested taskdev.json inside an existing project must be ignored');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// .vscode/tasks.json: discovered and run directly without import.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdev-vscode-'));
  try {
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vscode', 'tasks.json'), `{
      // Standard VS Code task file with JSONC comments/trailing commas.
      "version": "2.0.0",
      "tasks": [
        {
          "label": "npm: dev server",
          "type": "shell",
          "command": "npm",
          "args": ["run", "dev"],
          "options": {
            "cwd": "site",
            "env": { "PORT": "4322" },
          },
          "group": "build",
        },
        {
          "label": "dotnet build",
          "type": "process",
          "command": "dotnet",
          "args": ["build"],
        },
      ],
    }`);

    const tasksFile = path.join(root, '.vscode', 'tasks.json');
    const cfg = core.loadVscodeTasksConfig(tasksFile);
    assert.equal(cfg._imported, 'vscode');
    assert.deepEqual(cfg.tasks.map(t => t.name), ['npm-dev-server', 'dotnet-build']);
    assert.equal(cfg.tasks[0].command, 'npm run dev');
    assert.equal(cfg.tasks[0].cwd, path.join(root, 'site'));
    assert.deepEqual(cfg.tasks[0].env, { PORT: '4322' });
    assert.equal(cfg.tasks[0].category, 'build');

    const projects = core.discoverProjects([root]);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].imported, 'vscode');
    assert.equal(projects[0].readOnly, true);
    assert.equal(projects[0].tasksFile, tasksFile);
    assert.equal(projects[0].paths.stateFile, path.join(root, '.taskdev', 'state.json'));

    const listed = core.listTasks(projects[0].paths);
    assert.deepEqual(listed.map(t => t.name), ['npm-dev-server', 'dotnet-build']);
    assert.equal(listed[1].cwd, root);
    assert.equal(listed[0].source, 'vscode');

    assert.match(
      core.addTask(tasksFile, { name: 'extra', command: 'dotnet build' }, { confirm: 'ADD extra' }).error,
      /reads \.vscode\/tasks\.json directly/,
    );

    fs.writeFileSync(path.join(root, 'taskdev.json'), JSON.stringify({ project: 'Native', tasks: [] }));
    const nativeOnly = core.discoverProjects([root]);
    assert.equal(nativeOnly.length, 1);
    assert.equal(nativeOnly[0].tasksFile, path.join(root, 'taskdev.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

withTempProject(({ tasksFile }) => {
  fs.writeFileSync(tasksFile, JSON.stringify({
    project: 'Test',
    tasks: [
      { name: 'site', openBrowser: 'https://taskdev.dev' },
      { name: 'invalid', openBrowser: '/relative-only' },
      { name: 'build', command: 'dotnet build' },
    ],
  }, null, 2));

  const tasks = core.loadTasks(tasksFile);
  assert.deepEqual(tasks.map(t => t.name), ['site', 'build']);
  const browserOnly = tasks[0];
  assert.match(core.startTask(browserOnly, core.pathsFor(tasksFile)).error, /TaskDev sidebar/);
  const listed = core.listTasks(core.pathsFor(tasksFile));
  assert.equal(listed[0].command, null);
  assert.equal(listed[0].openBrowser, 'https://taskdev.dev');
  assert.equal(listed[0].logPath, null);
});

withTempProject(({ tasksFile }) => {
  fs.writeFileSync(tasksFile, JSON.stringify({
    project: 'Test',
    tasks: {
      Examples: [
        { name: 'home', openBrowser: 'https://taskdev.dev' },
      ],
      Build: [
        { name: 'compile', command: 'dotnet build' },
      ],
    },
  }, null, 2));

  const tasks = core.loadTasks(tasksFile);
  assert.deepEqual(tasks.map(t => t.name), ['home', 'compile']);
  assert.equal(tasks[0].category, 'Examples');
  assert.equal(tasks[1].category, 'Build');

  const listed = core.listTasks(core.pathsFor(tasksFile));
  assert.equal(listed[0].category, 'Examples');
  assert.equal(listed[0].openBrowser, 'https://taskdev.dev');
  assert.equal(listed[0].command, null);
});

withTempProject(({ tasksFile }) => {
  fs.writeFileSync(tasksFile, JSON.stringify({
    project: 'Test',
    tasks: {
      Build: [
        { name: 'compile', command: 'dotnet build' },
      ],
    },
  }, null, 2));
  const before = fs.readFileSync(tasksFile, 'utf8');

  const moved = core.moveTask(tasksFile, 'compile', 'up');
  assert.equal(moved.ok, false);
  assert.match(moved.error, /grouped task maps/);
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);
});

withTempProject(({ tasksFile }) => {
  assert.deepEqual(core.validateTaskCommand('dotnet build', tasksFile), {
    ok: true,
    command: 'dotnet build',
  });
  assert.equal(core.validateTaskCommand('sudo apt update', tasksFile).error, 'command uses a blocked executable');
  assert.equal(core.validateTaskCommand('dotnet build; rm -rf .', tasksFile).error, 'command contains unsupported characters');
});

withTempProject(({ tasksFile }) => {
  const added = core.addTask(tasksFile, { name: 'build', command: 'dotnet build' }, { confirm: 'ADD build' });
  assert.equal(added.ok, true);

  const missingConfirm = core.removeTask(tasksFile, 'build', { confirm: 'REMOVE wrong' });
  assert.equal(missingConfirm.ok, false);
  assert.match(missingConfirm.error, /confirmation required/);

  const removed = core.removeTask(tasksFile, 'build', { confirm: 'REMOVE build' });
  assert.equal(removed.ok, true);
  assert.equal(removed.task.name, 'build');

  const missing = core.removeTask(tasksFile, 'build', { confirm: 'REMOVE build' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'unknown task');
});

withTempProject(({ tasksFile }) => {
  fs.writeFileSync(tasksFile, JSON.stringify({
    project: 'Test',
    tasks: [
      { name: 'api', command: 'dotnet run', category: 'Services' },
      { name: 'lint', command: 'npm run lint' },
      { name: 'worker', command: 'dotnet run', category: 'Services' },
      { name: 'test', command: 'npm test' },
    ],
  }, null, 2));

  const movedService = core.moveTask(tasksFile, 'worker', 'up');
  assert.equal(movedService.ok, true);
  assert.equal(movedService.moved, true);
  assert.deepEqual(core.loadConfig(tasksFile).tasks.map(t => t.name), ['worker', 'lint', 'api', 'test']);

  const movedUncategorized = core.moveTask(tasksFile, 'lint', 'down');
  assert.equal(movedUncategorized.ok, true);
  assert.equal(movedUncategorized.moved, true);
  assert.deepEqual(core.loadConfig(tasksFile).tasks.map(t => t.name), ['worker', 'test', 'api', 'lint']);

  const atBoundary = core.moveTask(tasksFile, 'worker', 'up');
  assert.equal(atBoundary.ok, true);
  assert.equal(atBoundary.moved, false);
  assert.equal(core.moveTask(tasksFile, 'missing', 'up').error, 'unknown task');
  assert.match(core.moveTask(tasksFile, 'api', 'sideways').error, /direction/);
});

withTempProject(({ tasksFile }) => {
  fs.writeFileSync(tasksFile, JSON.stringify({
    project: 'Test',
    tasks: [
      { name: 'api', command: 'dotnet run', category: 'Services' },
      { name: 'lint', command: 'npm run lint' },
      { name: 'worker', command: 'dotnet run', category: 'Services' },
      { name: 'test', command: 'npm test' },
      { name: 'web', command: 'npm run dev', category: 'Web' },
    ],
  }, null, 2));

  const beforeWorker = core.moveTaskTo(tasksFile, 'lint', { beforeName: 'worker' });
  assert.equal(beforeWorker.ok, true);
  let tasks = core.loadConfig(tasksFile).tasks;
  assert.deepEqual(tasks.map(t => t.name), ['api', 'lint', 'worker', 'test', 'web']);
  assert.equal(tasks.find(t => t.name === 'lint').category, 'Services');

  const intoWeb = core.moveTaskTo(tasksFile, 'api', { category: 'Web' });
  assert.equal(intoWeb.ok, true);
  tasks = core.loadConfig(tasksFile).tasks;
  assert.deepEqual(tasks.map(t => t.name), ['lint', 'worker', 'test', 'web', 'api']);
  assert.equal(tasks.find(t => t.name === 'api').category, 'Web');

  const uncategorized = core.moveTaskTo(tasksFile, 'web', { category: null });
  assert.equal(uncategorized.ok, true);
  tasks = core.loadConfig(tasksFile).tasks;
  assert.deepEqual(tasks.map(t => t.name), ['lint', 'worker', 'test', 'web', 'api']);
  assert.equal(Object.hasOwn(tasks.find(t => t.name === 'web'), 'category'), false);

  const sameTarget = core.moveTaskTo(tasksFile, 'worker', { beforeName: 'worker' });
  assert.equal(sameTarget.ok, true);
  assert.equal(sameTarget.moved, false);
  assert.equal(core.moveTaskTo(tasksFile, 'worker', { beforeName: 'missing' }).error, 'unknown target task');
});

withTempProject(({ tasksFile }) => {
  fs.writeFileSync(tasksFile, JSON.stringify({
    project: 'Test',
    tasks: [
      { name: 'api', command: 'dotnet run' },
      { name: 'web', command: 'npm run dev', category: 'Frontend' },
    ],
  }, null, 2));

  const added = core.setTaskCategory(tasksFile, 'api', ' Services ');
  assert.equal(added.ok, true);
  assert.equal(core.loadConfig(tasksFile).tasks[0].category, 'Services');

  const changed = core.setTaskCategory(tasksFile, 'api', 'Backend');
  assert.equal(changed.ok, true);
  assert.equal(core.loadConfig(tasksFile).tasks[0].category, 'Backend');

  const removed = core.setTaskCategory(tasksFile, 'web', '');
  assert.equal(removed.ok, true);
  assert.equal(Object.hasOwn(core.loadConfig(tasksFile).tasks[1], 'category'), false);

  assert.equal(core.setTaskCategory(tasksFile, 'missing', 'Backend').error, 'unknown task');
  assert.match(core.setTaskCategory(tasksFile, 'api', 'x'.repeat(65)).error, /64 characters/);
});

withTempProject(({ tasksFile }) => {
  fs.writeFileSync(tasksFile, JSON.stringify({
    project: 'Test',
    tasks: [{
      name: 'build',
      type: 'npm',
      command: 'npm run build',
      detail: 'Creates production build',
    }],
  }, null, 2));

  const [task] = core.listTasks(core.pathsFor(tasksFile));
  assert.equal(task.type, 'npm');
  assert.equal(task.detail, 'Creates production build');
  assert.equal(Object.hasOwn(task, 'icon'), false);
});

withTempProject(({ tasksFile }) => {
  fs.writeFileSync(tasksFile, '{ broken json');
  const before = fs.readFileSync(tasksFile, 'utf8');

  const added = core.addTask(tasksFile, { name: 'build', command: 'dotnet build' }, { confirm: 'ADD build' });
  assert.equal(added.ok, false);
  assert.match(added.error, /invalid JSON/);
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);

  const removed = core.removeTask(tasksFile, 'build', { confirm: 'REMOVE build' });
  assert.equal(removed.ok, false);
  assert.match(removed.error, /invalid JSON/);
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);
});

withTempProject(({ tasksFile }) => {
  const currentFingerprint = core.processFingerprint(process.pid);
  if (!currentFingerprint) return;
  core._clearVerifiedFingerprintCache();
  const paths = core.pathsFor(tasksFile);
  core.writeState(paths.stateFile, {
    tasks: {
      stale: {
        pid: process.pid,
        command: 'dotnet build',
        cwd: path.dirname(tasksFile),
        startedAt: Date.now(),
        processFingerprint: 'not-this-process',
        status: 'running',
      },
    },
  });
  const { state } = core.reconcile(core.readState(paths.stateFile));
  assert.equal(state.tasks.stale, undefined);
});

// Fingerprint verification is cached per PID so reconcile doesn't spawn
// wmic/powershell on every tick. Observe the cache directly: after one
// successful isAlive() it must contain the PID, and stay flat across more
// calls. pidAlive on our own process is cheap so the loop is safe.
{
  const realFp = core.processFingerprint(process.pid);
  if (realFp) {
    core._clearVerifiedFingerprintCache();
    assert.equal(core._verifiedFingerprintCacheSize(), 0);
    const entry = { pid: process.pid, processFingerprint: realFp };
    assert.equal(core.isAlive(entry), true);
    assert.equal(core._verifiedFingerprintCacheSize(), 1,
      'first isAlive should populate the verified-fingerprint cache');
    for (let i = 0; i < 5; i++) assert.equal(core.isAlive(entry), true);
    assert.equal(core._verifiedFingerprintCacheSize(), 1,
      'subsequent isAlive calls must reuse the cached fingerprint');
    // A dead PID must be evicted so a real PID reuse gets re-verified.
    assert.equal(core.isAlive({ pid: 99999999, processFingerprint: 'x' }), false);
    assert.equal(core._verifiedFingerprintCacheSize(), 1);
  }
}

// tailLog: byte budget caps the returned text even when many lines fit.
withTempProject(({ tasksFile }) => {
  const paths = core.ensureRuntimeDirs(core.pathsFor(tasksFile));
  const logPath = core.newLogPath(paths, 'big');
  // Build a ~200 KB log with predictable lines.
  const line = 'x'.repeat(200);
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`${i}-${line}`);
  fs.writeFileSync(logPath, lines.join('\n') + '\n');

  const def = core.tailLog(paths, 'big', 1000);
  assert.equal(def.ok, true);
  assert.ok(def.returnedBytes <= core.TAIL_READ_DEFAULT_BYTES,
    `default tail should fit in ${core.TAIL_READ_DEFAULT_BYTES} bytes, got ${def.returnedBytes}`);
  assert.equal(def.truncated, true);

  const small = core.tailLog(paths, 'big', 1000, undefined, 4096);
  assert.equal(small.ok, true);
  assert.ok(small.returnedBytes <= 4096, `byte budget honored: ${small.returnedBytes}`);
  assert.equal(small.truncated, true);
  // Last line of the file must be present in the returned tail.
  assert.match(small.text, /999-x{10,}\n?$/);

  // bytes above TAIL_READ_MAX_BYTES is clamped, not honored verbatim.
  const huge = core.tailLog(paths, 'big', 1000, undefined, 10 * 1024 * 1024);
  assert.ok(huge.returnedBytes <= core.TAIL_READ_MAX_BYTES,
    'oversized bytes should be clamped to TAIL_READ_MAX_BYTES');
});

withTempProject(({ tasksFile }) => {
  fs.writeFileSync(tasksFile, JSON.stringify({
    project: 'Test',
    tasks: [{ name: 'stale', command: 'dotnet build' }],
  }, null, 2));
  const paths = core.pathsFor(tasksFile);
  core.writeState(paths.stateFile, {
    tasks: {
      stale: {
        pid: 99999999,
        command: 'dotnet build',
        cwd: path.dirname(tasksFile),
        startedAt: Date.now(),
        status: 'running',
      },
    },
  });

  const [task] = core.listTasks(paths, { reconcile: false });
  assert.equal(task.status, 'running');
  assert.equal(task.pid, 99999999);
});

(async () => {
  await withTempProjectAsync(async ({ dir, tasksFile }) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: {
        emit: 'node -e "console.log(\'task stdout captured\')"',
      },
    }, null, 2));
    const paths = core.pathsFor(tasksFile);
    const started = core.startTask({ name: 'emit', command: 'npm run emit' }, paths);
    assert.equal(started.ok, true);

    const deadline = Date.now() + 15000;
    let log = null;
    while (Date.now() < deadline) {
      log = core.tailLog(paths, 'emit', 100);
      if (log.ok && /task stdout captured/.test(log.text) && /\n\[[^\]]+\] exit:/.test(log.text)) break;
      await delay(100);
    }

    assert.equal(log.ok, true);
    assert.match(log.text, /task stdout captured/);
    assert.match(log.text, /\n\[[^\]]+\] exit:/);
  });

  console.log('core tests passed');
})().catch(e => {
  console.error(e);
  process.exit(1);
});

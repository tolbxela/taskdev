'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../core.cjs');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const packageRoot = path.join(root, 'extension');
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const outDir = path.join(root, 'versions');
const outFile = path.join(outDir, `taskdev-${pkg.version}.vsix`);

fs.mkdirSync(outDir, { recursive: true });

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(command, ['--yes', '@vscode/vsce', 'package', '-o', outFile], {
  cwd: packageRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);

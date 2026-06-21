'use strict';
// Bundles the extension entry (CJS) and the MCP server entry (ESM) into
// dist/ using esbuild. Drops a 1.87 MB vsix (1388 files) down to a couple
// of hundred KB. Source files at the repo root stay where they are for
// development and unit tests; .vscodeignore excludes them from the vsix.
//
// Externals:
//   - `vscode` is provided by the VS Code host at runtime and MUST NOT be
//     bundled. Everything else (zod, the MCP SDK, our own core.cjs) is
//     inlined into the output bundles, so node_modules can be excluded
//     entirely from the published extension.

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');

// Wipe dist/ so we never ship stale artifacts from a previous build.
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
  // Inline JSON files (package.json) and CJS modules (core.cjs) at build
  // time so the bundled outputs are self-contained.
  loader: { '.json': 'json' },
};

async function main() {
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(root, 'extension.js')],
    outfile: path.join(distDir, 'extension.cjs'),
    format: 'cjs',
    external: ['vscode'],
  });
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(root, 'mcp.mjs')],
    outfile: path.join(distDir, 'mcp.mjs'),
    format: 'esm',
    // ESM doesn't expose a runtime `require`, but some bundled CJS deps
    // (and our use of node built-ins) call `require()` after esbuild's
    // CJS-to-ESM conversion. Inject a `createRequire` polyfill so those
    // calls resolve correctly. The shebang must be the very first byte of
    // the file, so it ALSO goes in this banner (the source no longer
    // carries one).
    banner: {
      js: [
        '#!/usr/bin/env node',
        'import { createRequire } from "node:module";',
        'const require = createRequire(import.meta.url);',
      ].join('\n'),
    },
  });

  // Print final sizes so the prepublish hook gives useful CI output.
  for (const name of ['extension.cjs', 'mcp.mjs']) {
    const p = path.join(distDir, name);
    const kb = (fs.statSync(p).size / 1024).toFixed(1);
    console.log(`  ${path.relative(root, p)} -> ${kb} KB`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

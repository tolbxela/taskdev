'use strict';

// Copies the repo-root docs into the site's content collection so Astro can
// render them. Single source of truth lives in /docs; the site owns layout.
// Run by `npm run dev` / `npm run build` via the prebuild hook.

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const srcDir = path.join(repoRoot, 'docs');
const dstDir = path.join(__dirname, '..', 'src', 'content', 'docs');

// [source filename, destination slug, frontmatter title, order, summary]
const DOCS = [
  {
    src: 'usage.md',
    slug: 'usage',
    title: 'Usage Guide',
    order: 1,
    summary: 'Practical recipes for setting up TaskDev in real projects.',
  },
  {
    src: 'config.md',
    slug: 'config',
    title: 'Configuration Reference',
    order: 2,
    summary: 'Schema, fields, runtime files, editor settings, and the MCP tools surface.',
  },
  {
    src: 'security.md',
    slug: 'security',
    title: 'Security and Sandboxing',
    order: 3,
    summary: 'Trust model, allow-list, denylist, and the rules applied to agent-added tasks.',
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stripLeadingH1(md) {
  // Drop the first heading if it's an h1 - the site layout renders its own.
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^#\s+/.test(lines[i])) {
    lines.splice(i, 1);
    // Also drop the blank line that typically follows.
    if (i < lines.length && lines[i].trim() === '') lines.splice(i, 1);
  }
  return lines.join('\n');
}

function rewriteCrossLinks(md) {
  // Sources cross-reference each other with relative paths
  // (e.g. [usage.md](usage.md)). In the site those become /docs/<slug>.
  const map = {
    'usage.md': '/docs/usage',
    'config.md': '/docs/config',
    'security.md': '/docs/security',
  };
  let out = md;
  for (const [file, url] of Object.entries(map)) {
    const esc = file.replace(/\./g, '\\.');
    out = out
      .replace(new RegExp(`\\]\\((?:\\./)?${esc}\\)`, 'g'), `](${url})`)
      .replace(new RegExp(`\\]\\(\`${esc}\`\\)`, 'g'), `](${url})`);
  }
  return out;
}

function toFrontmatter(meta) {
  const lines = [
    '---',
    `title: ${JSON.stringify(meta.title)}`,
    `order: ${meta.order}`,
    `summary: ${JSON.stringify(meta.summary)}`,
    `source: ${JSON.stringify(meta.src)}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

function writeIfChanged(filePath, content) {
  let existing = null;
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch {}
  if (existing === content) return false;
  fs.writeFileSync(filePath, content);
  return true;
}

function main() {
  if (!fs.existsSync(srcDir)) {
    const complete = DOCS.every((doc) =>
      fs.existsSync(path.join(dstDir, `${doc.slug}.md`))
    );
    if (!complete) {
      throw new Error(
        'repo-root docs are unavailable and generated site docs are incomplete'
      );
    }
    // A standalone /site container build uses the generated copies committed
    // to the repository. Full-repository builds continue to refresh them.
    console.log(`sync-docs: using ${DOCS.length} generated file(s)`);
    return;
  }

  ensureDir(dstDir);
  let written = 0;
  for (const doc of DOCS) {
    const sourcePath = path.join(srcDir, doc.src);
    const raw = fs.readFileSync(sourcePath, 'utf8');
    const body = rewriteCrossLinks(stripLeadingH1(raw));
    const out = toFrontmatter(doc) + body.replace(/^\s+/, '') + (body.endsWith('\n') ? '' : '\n');
    const dstPath = path.join(dstDir, `${doc.slug}.md`);
    if (writeIfChanged(dstPath, out)) written++;
  }
  // eslint-disable-next-line no-console
  console.log(`sync-docs: ${written} file(s) updated, ${DOCS.length} total`);
}

main();

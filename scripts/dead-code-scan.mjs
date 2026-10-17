/**
 * Static dead-export scanner.
 *
 * Finds symbols that are exported but never referenced, and symbols that are exported
 * without needing to be. Both are pure redundancy: an unused export widens a module's
 * public surface for no consumer, and it silently rots once the only reference is the
 * definition site itself.
 *
 * Method: extract every exported name from src/** and tests/**, strip import/export
 * specifier statements and comments, then count word-boundary references per file.
 * A name's use count is its total occurrences minus its own definition sites minus any
 * re-export specifiers. References inside the defining file are reported separately so
 * "used only here" can be distinguished from "genuinely dead".
 *
 * Run: npm run scan:dead
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['src', 'tests'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d)));

/** Remove import/export specifier statements, block/line comments and HTML comments
 *  so that a definition or re-export never counts as a usage. */
function referenceText(source) {
  return source
    .replace(/^[ \t]*import\b[\s\S]*?['"][^'"]*['"];?/gm, '\n')
    .replace(/^[ \t]*export\s*\{[\s\S]*?\}\s*(?:from\s*['"][^'"]*['"])?;?/gm, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const code = new Map(
  [...sources].map(([f, s]) => [f, referenceText(s)])
);

const DEFINITION_PATTERNS = [
  /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /export\s+class\s+([A-Za-z_$][\w$]*)/g,
  /export\s+interface\s+([A-Za-z_$][\w$]*)/g,
  /export\s+type\s+([A-Za-z_$][\w$]*)/g,
  /export\s+enum\s+([A-Za-z_$][\w$]*)/g,
];

function addTo(map, key, val) {
  if (!map.has(key)) map.set(key, new Map());
  map.get(key).set(val, (map.get(key).get(val) || 0) + 1);
}

const definitions = new Map();
const reExports = new Map();

for (const [file, text] of sources) {
  for (const pattern of DEFINITION_PATTERNS) {
    for (const match of text.matchAll(pattern)) addTo(definitions, match[1], file);
  }
  for (const match of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      if (!reExports.has(name)) reExports.set(name, new Set());
      reExports.get(name).add(file);
    }
  }
}

function references(name) {
  const pattern = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  const perFile = new Map();
  let total = 0;
  for (const [file, text] of code) {
    const n = [...text.matchAll(pattern)].length;
    if (n > 0) {
      perFile.set(file, n);
      total += n;
    }
  }
  return { total, perFile };
}

const findings = [];

for (const [name, defSites] of definitions) {
  const { total, perFile } = references(name);

  let definedAt = 0;
  for (const count of defSites.values()) definedAt += count;

  let reExportedAt = 0;
  for (const file of reExports.get(name) ?? []) reExportedAt += perFile.get(file) ?? 0;

  let usedInternally = 0;
  for (const [file, count] of defSites) usedInternally += (perFile.get(file) ?? 0) - count;

  const uses = total - definedAt - reExportedAt;
  findings.push({
    name,
    kind: 'definition',
    file: relative(ROOT, [...defSites.keys()][0]).split(sep).join('/'),
    uses,
    usedElsewhere: uses - usedInternally,
  });
}

for (const [name, files] of reExports) {
  if (definitions.has(name)) continue;
  findings.push({
    name,
    kind: 're-export',
    file: relative(ROOT, [...files][0]).split(sep).join('/'),
    uses: references(name).total,
    usedElsewhere: references(name).total,
  });
}

const dead = findings.filter((f) => f.uses <= 0);
const internalOnly = findings.filter((f) => f.uses > 0 && f.usedElsewhere <= 0);

const report = (rows) =>
  rows.length === 0
    ? '  (none)'
    : rows.map((r) => `  ${r.name.padEnd(32)} ${r.file}`).join('\n');

console.log(`files scanned : ${files.length}  (src/** + tests/**)`);
console.log(`exported names: ${findings.length}`);
console.log(`dead exports  : ${dead.length}`);
console.log(`internal-only : ${internalOnly.length}\n`);
console.log('DEAD:' + report(dead));
console.log('\nEXPORTED BUT ONLY USED IN ITS OWN FILE:' + report(internalOnly));

process.exit(dead.length + internalOnly.length === 0 ? 0 : 1);

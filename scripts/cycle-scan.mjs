/**
 * Import-cycle detector.
 *
 * A cycle is the one coupling defect no type checker reports: every module resolves,
 * every signature matches, and the code still ships. Cycles also make the module graph
 * order-dependent at evaluation time, so a benign-looking edit can change behaviour.
 *
 * Two kinds are distinguished, because they fail differently:
 *
 *   value cycle  - at least one back-edge is a real binding. The emitted JS contains a
 *                  require/import edge that can close, hitting a temporal dead zone or a
 *                  half-initialised module. A defect; fails the gate.
 *   type cycle   - every back-edge is `import type`, which TypeScript erases. The runtime
 *                  graph is a DAG and nothing breaks, but the modules still know about each
 *                  other. A coupling smell; reported, does not fail.
 *
 * Method: take the `<script>` block of every source unit, read its import/export-from
 * specifiers (multi-line forms included), resolve them to files through the `@/` alias
 * and relative paths, then run Tarjan's algorithm over the value-only subgraph and over
 * the full graph. A strongly connected component with more than one member is a cycle, as
 * is a module importing itself.
 *
 * Run: npm run scan:cycles
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['src', 'tests'];
const CANDIDATE_SUFFIXES = ['', '.ts', '.d.ts', '.tsx', '.vue', '/index.ts', '/index.vue'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(p);
  }
  return out;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const normalize = (p) => p.split(sep).join('/');

/** Vue SFCs keep imports inside `<script>`; scanning only that block keeps template
 *  text (`//` in URLs, quotes in attributes) out of the specifier matcher. */
function scriptSource(file, text) {
  if (!file.endsWith('.vue')) return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const blocks = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return blocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// Captures the specifier as the first quoted string after the keyword, so a side-effect
// import (`import './x.css'`) names its own module instead of reaching for a later `from`.
const STATEMENT = /^[ \t]*(?:import|export)\b([\s\S]*?)['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function edgesFrom(source) {
  const found = new Map();
  const record = (spec, typeOnly) => {
    if (!found.has(spec)) found.set(spec, { spec, typeOnly });
    else found.get(spec).typeOnly = found.get(spec).typeOnly && typeOnly;
  };

  for (const m of source.matchAll(STATEMENT)) {
    // `import type {…}` / `export type {…}` bind nothing at runtime; an inline
    // `{ type X, Y }` still carries a value binding, so it stays a value edge.
    record(m[2], /^\s*type\b/.test(m[1]));
  }
  for (const m of source.matchAll(DYNAMIC)) record(m[1], false);
  return [...found.values()];
}

function resolveSpecifier(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = join(dirname(fromFile), spec);
  else return null; // bare package specifier, outside the module graph under test
  for (const suffix of CANDIDATE_SUFFIXES) {
    if (isFile(base + suffix)) return base + suffix;
  }
  return undefined; // in-project specifier that points at nothing
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
const known = new Set(files.map(normalize));

const edges = files.map((file) => ({ file, to: [] }));
const byFile = new Map(edges.map((e) => [e.file, e]));
const unresolved = [];

for (const file of files) {
  const source = scriptSource(file, readFileSync(file, 'utf8'));
  for (const { spec, typeOnly } of edgesFrom(source)) {
    const target = resolveSpecifier(spec, file);
    if (target === null) continue;
    if (target === undefined) {
      unresolved.push(`  ${normalize(relative(ROOT, file))} -> ${spec}`);
      continue;
    }
    if (known.has(normalize(target))) byFile.get(file).to.push({ target, typeOnly });
  }
}

function adjacency(valueOnly) {
  const graph = new Map(files.map((f) => [f, []]));
  for (const { file, to } of edges) {
    graph.get(file).push(...to.filter((e) => !valueOnly || !e.typeOnly).map((e) => e.target));
  }
  return graph;
}

/** Tarjan: iterative so a deep graph cannot overflow the stack. */
function stronglyConnected(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const found = [];
  let counter = 0;

  for (const start of graph.keys()) {
    if (index.has(start)) continue;

    const work = [{ node: start, edge: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const { node } = frame;

      if (frame.edge === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }

      if (frame.edge < graph.get(node).length) {
        const next = graph.get(node)[frame.edge++];
        if (!index.has(next)) work.push({ node: next, edge: 0 });
        else if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
        continue;
      }

      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }

      if (low.get(node) === index.get(node)) {
        const component = [];
        for (;;) {
          const popped = stack.pop();
          onStack.delete(popped);
          component.push(popped);
          if (popped === node) break;
        }
        if (component.length > 1) found.push(component.reverse());
      }
    }
  }
  return found;
}

const key = (component) => component.map(normalize).sort().join('|');

const valueCycles = stronglyConnected(adjacency(true));
for (const { file, to } of edges) {
  if (to.some((e) => e.target === file && !e.typeOnly)) valueCycles.push([file]);
}

const reported = new Set(valueCycles.map(key));
const typeCycles = stronglyConnected(adjacency(false)).filter((c) => !reported.has(key(c)));

const show = (component) => component.map((p) => normalize(relative(ROOT, p))).join(' -> ');

console.log(`modules scanned   : ${files.length}  (src/** + tests/**)`);
console.log(`edges resolved    : ${edges.reduce((n, e) => n + e.to.length, 0)}`);
console.log(`value cycles      : ${valueCycles.length}`);
console.log(`type-only cycles  : ${typeCycles.length}`);
console.log(`unresolved imports: ${unresolved.length}\n`);

console.log(
  'VALUE CYCLES (runtime-breaking):\n' +
    (valueCycles.length ? valueCycles.map((c) => '  ' + show(c)).join('\n') : '  (none)')
);
console.log(
  '\nTYPE-ONLY CYCLES (erased at compile time, reported only):\n' +
    (typeCycles.length ? typeCycles.map((c) => '  ' + show(c)).join('\n') : '  (none)')
);
if (unresolved.length > 0) {
  console.log('\nSPECIFIERS THAT RESOLVE TO NOTHING:\n' + unresolved.join('\n'));
}

process.exit(valueCycles.length === 0 ? 0 : 1);

#!/usr/bin/env node
'use strict';
// Correctness differential; never touches corpus databases or engine files.
// Usage: node scripts/benchmarks/haskell-export-absence-differential.cjs
//   --baseline ENGINE_ROOT --candidate ENGINE_ROOT --output NEW_REPORT.json
// Optional: --cases EVEN_COUNT (defaults to 1000).
// Parent enforces a 30 s child cap and 512 MiB V8 heap. Timing is NOT a benchmark.
// Fixtures model resolver metadata, including synthetic named renames; they do
// not claim that every generated combination is legal Haskell source syntax.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

const options = {
  baseline: null,
  candidate: null,
  output: null,
  cases: 1000,
  worker: false,
};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--worker') { options.worker = true; continue; }
  if (!['--baseline', '--candidate', '--output', '--cases'].includes(flag) || !process.argv[i + 1]) {
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  options[flag.slice(2)] = flag === '--cases' ? Number(process.argv[++i]) : path.resolve(process.argv[++i]);
}
if (!options.baseline || !options.candidate || (!options.worker && !options.output)) {
  throw new Error('--baseline, --candidate and --output are required');
}
if (!Number.isInteger(options.cases) || options.cases < 24 || options.cases > 2000 || options.cases % 2) {
  throw new Error('--cases must be an even integer from 24 through 2000');
}

if (!options.worker) {
  if (fs.existsSync(options.output)) throw new Error('Existing report refused; choose a new --output');
  const run = spawnSync(process.execPath, ['--max-old-space-size=512', __filename, '--worker',
    '--baseline', options.baseline, '--candidate', options.candidate, '--cases', String(options.cases)], {
    timeout: 30_000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CODEGRAPH_KERNEL: '0', CODEGRAPH_TELEMETRY: '0' },
  });
  let report;
  try { report = JSON.parse(run.stdout); }
  catch { report = { schemaVersion: 1, completed: false, passed: false, error: 'Worker returned no complete JSON report' }; }
  report.process = { exitCode: run.status, signal: run.signal, timeout: run.error?.code === 'ETIMEDOUT',
    maxHeapMiB: 512, timeoutMs: 30_000 };
  if (run.error || run.status !== 0) report.passed = false;
  // Only expose stable diagnostics; stacks or shell strings may contain local paths.
  if (run.stderr) report.process.stderrPresent = true;
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: path.basename(options.output), completed: report.completed,
    passed: report.passed, summary: report.summary, process: report.process }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

function sanitize(value) {
  return value.split(options.baseline).join('<baseline>').split(options.candidate).join('<candidate>')
    .split(__dirname).join('<scratch>');
}

function loadEngine(root, oracle = false) {
  const file = path.join(root, 'dist/resolution/import-resolver.js');
  const original = fs.readFileSync(file, 'utf8');
  const marker = 'return traversal.exhausted ? HASKELL_EXPORT_AMBIGUOUS : result;';
  if (original.split(marker).length !== 2) throw new Error('Expected one unchanged export-walk diagnostic marker');
  let source = original.replace(marker,
    'exports.__auditWalks.push({ name:want.exportedName, exhausted:traversal.exhausted, remaining:traversal.remaining }); ' + marker);
  if (oracle) {
    const budget = /const REEXPORT_MAX_VISITS = (?:10_000|10000);/g;
    if ([...source.matchAll(budget)].length !== 1) throw new Error('Expected one baseline visit-budget declaration');
    source = source.replace(budget, 'const REEXPORT_MAX_VISITS = 200000;');
  }
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(source, file);
  loaded.exports.__auditWalks = [];
  return { api: loaded.exports, sha256: crypto.createHash('sha256').update(original).digest('hex'),
    visitBudget: oracle ? 200000 : 10000 };
}

function rng(seed) {
  let state = seed >>> 0;
  return limit => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % limit;
  };
}
const parents = ['A', 'B', 'C'];
const wild = (source, props = {}) => ({ kind: 'wildcard', source, ...props });
const named = (source, name, originalName = name, props = {}) => ({
  kind: 'named', source, exportedName: name, originalName, ...props,
});
function restriction(random, name) {
  const owner = parents[random(3)];
  switch (random(16)) {
    case 0: return { includedNames: [] };
    case 1: return { includedParentExports: [] };
    case 2: return { includedParentChildren: [] };
    case 3: return { includedNames: [name] };
    case 4: return { excludedNames: [name] };
    case 5: return { includedParentExports: [owner, owner] };
    case 6: return { excludedParentExports: [owner] };
    case 7: return { includedParentChildren: [{ parent: owner, child: name }] };
    case 8: return { excludedParentChildren: [{ parent: owner, child: name, haskellValueOnly: true }] };
    case 9: return { includedNames: [name], haskellTypeOnlyNames: [name] };
    case 10: return { includedNames: [name], haskellValueOnlyNames: [name] };
    case 11: return { excludedNames: [name], haskellTypeOnlyNames: [name] };
    case 12: return { includedNames: [name], haskellClearParent: true };
    case 13: return { includedParentExports: [owner], haskellCollapsedParents: true };
    case 14: return { includedParentChildren: [{ parent: owner, child: name, haskellTypeOnly: true }] };
    default: return {};
  }
}

function fixture(serial) {
  const seed = (0x19_09_2026 ^ Math.imul(serial + 1, 0x9e3779b1)) >>> 0;
  const random = rng(seed), family = serial % 12, count = family === 1 ? 16 : 4 + random(12);
  const name = family === 5 ? 'Thing' : family === 6 ? (random(2) ? ':::' : '<$>') : 'wanted';
  const routes = Object.fromEntries(Array.from({ length: count }, (_, i) => [`M${i}`, []]));
  const declarations = [];
  const put = (mod, spelling = name, owner = '', kind = 'function') => declarations.push({
    id: `declaration:${serial}:${declarations.length}`, name: spelling,
    qualifiedName: [mod, ...(owner ? [owner] : []), spelling].join('::'),
    filePath: `${mod}.hs`, kind, language: 'haskell', isExported: random(10) !== 0,
    startLine: 2, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 0,
  });
  switch (family) {
    case 0: {
      let current = name;
      for (let i = 0; i < count - 1; i++) {
        const next = i % 2 ? name : 'renamed';
        routes[`M${i}`] = [named(`M${i + 1}`, current, next)]; current = next;
      }
      put(`M${count - 1}`, current); break;
    }
    case 1:
      // Dense acyclic negative graph: 16 distinct modules, no duplicate routes.
      // Frozen traversal may exceed 10k; a complete 200k oracle can certify it.
      for (let i = 0; i < count - 1; i++) {
        for (let j = i + 1; j < count; j++) routes[`M${i}`].push(wild(`M${j}`));
      }
      if (random(2)) put('M0');
      break;
    case 2:
      routes.M0 = [wild('M1')]; routes.M1 = [wild('M2')]; routes.M2 = [wild('M0'), wild('M3')];
      if (random(2)) put('M3');
      break;
    case 3:
      routes.M0 = parents.map(parentExport => named('M1', name, name, { parentExport }));
      routes.M1 = [wild('M2', restriction(random, name))];
      put('M2', name, parents[random(3)], 'field');
      if (random(2)) put('M2', name, parents[random(3)], 'field');
      break;
    case 4:
      routes.M0 = [wild('M1', restriction(random, name))]; routes.M1 = [wild('M2')];
      put('M2', name, 'A', 'field');
      if (random(2)) routes.M0.push(wild('M3'));
      if (random(2)) put('M3');
      break;
    case 5:
      routes.M0 = [wild('M1', restriction(random, name))]; routes.M1 = [wild('M2')];
      put('M2', name, 'A', 'enum_member'); put('M2', name, 'B', 'type_alias');
      break;
    case 6:
      routes.M0 = [wild('M1', random(2) ? {} : restriction(random, name))];
      routes.M1 = [named('M2', name)]; put('M2', random(2) ? name : `(${name})`, 'A', 'field');
      break;
    case 7:
      routes.M0 = [named('M1', name, name, { packageQualifier: 'external' })];
      if (random(2)) routes.M0.push(named('M1', name));
      put('M1');
      break;
    case 8:
      routes.M0 = ['A', 'B'].map(parentExport => named('M1', name, name, { parentExport }));
      routes.M1 = random(2) ? [named('M2', name)]
        : [wild('M2', { includedNames: [name], haskellClearParent: true })];
      put('M2', name, 'C', 'field');
      break;
    case 9:
      routes.M0 = ['A', 'B'].map(owner => wild('M1', { includedParentExports: [owner] }));
      routes.M1 = [wild('M2')]; put('M2', name, 'B', 'field');
      if (random(2)) put('M2', name, 'A', 'field');
      break;
    case 10:
      routes.M0 = [wild('Missing'), wild('M1', restriction(random, name))];
      routes.M1 = [wild('M2')]; put('M2', 'unrelated');
      break;
    case 11:
      for (let i = 0; i < count; i++) {
        for (let edge = 0, edges = 1 + random(4); edge < edges; edge++) {
          const source = `M${random(count)}`;
          routes[`M${i}`].push(random(3) ? wild(source, restriction(random, name))
            : named(source, name, random(4) ? name : 'renamed', {
              ...(random(2) ? { parentExport: parents[random(3)] } : {}),
              ...(random(6) === 0 ? { haskellTypeOnly: true } : {}),
            }));
        }
        if (random(4) === 0) put(`M${i}`, random(4) ? name : 'renamed', parents[random(3)], random(3) ? 'field' : 'type_alias');
      }
      break;
  }
  const queries = [
    { root: 'M0', name, namespace: family === 5 && random(2) ? 'type' : 'value' },
    { root: random(2) ? 'M0' : 'M1', name,
      namespace: family === 5 ? 'type' : random(4) === 0 ? 'type' : 'value' },
  ];
  // Exercise incompatible value/type lookups on the SAME context and spelling.
  if (family === 5) { queries[0].namespace = 'value'; queries[1].namespace = 'type'; queries[1].root = 'M0'; }
  return { serial, seed, family, routes, declarations, queries, moduleCount: count + 2 };
}

function makeContext(input) {
  const graph = JSON.parse(JSON.stringify(input)); // independent immutable route identities per engine
  const files = Object.keys(graph.routes).map(mod => `${mod}.hs`).concat(['Consumer0.hs', 'Consumer1.hs']);
  if (files.length > 20) throw new Error('Fixture module limit exceeded');
  const nodes = graph.declarations.concat(files.map(file => ({
    id: `namespace:${file}`, name: file.slice(0, -3), qualifiedName: file.slice(0, -3), kind: 'namespace',
    filePath: file, language: 'haskell', isExported: true,
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0,
  })));
  const index = field => {
    const result = new Map();
    for (const node of nodes) { const key = node[field], values = result.get(key) || []; values.push(node); result.set(key, values); }
    return result;
  };
  const byFile = index('filePath'), byName = index('name'), byQualified = index('qualifiedName'), byKind = index('kind');
  const byId = new Map(nodes.map(node => [node.id, node]));
  const known = new Set(files);
  const imports = graph.queries.map(query => [{ localName: query.name, exportedName: query.name,
    source: query.root, isDefault: false, isNamespace: false }]);
  let routeReads = 0;
  const context = {
    getNodeById: id => byId.get(id) || null,
    getNodesInFile: file => byFile.get(file) || [], getNodesByName: name => byName.get(name) || [],
    getNodesByQualifiedName: name => byQualified.get(name) || [], getNodesByKind: kind => byKind.get(kind) || [],
    getNodesByLowerName: name => nodes.filter(node => node.name.toLowerCase() === name),
    fileExists: file => known.has(file), readFile: file => known.has(file) ? `module ${file.slice(0, -3)} where` : null,
    getProjectRoot: () => '/synthetic-haskell-absence-fixture', getAllFiles: () => files,
    getImportMappings: file => file === 'Consumer0.hs' ? imports[0] : file === 'Consumer1.hs' ? imports[1] : [],
    getReExports: file => {
      if (++routeReads > 450000) throw new Error('Per-query fixture route-read guard exceeded');
      return graph.routes[file.slice(0, -3)] || [];
    },
  };
  return { context, reset: () => { routeReads = 0; }, reads: () => routeReads };
}

function resolve(engine, fixtureContext, input, queryIndex) {
  fixtureContext.reset(); engine.api.__auditWalks = [];
  const query = input.queries[queryIndex];
  const result = engine.api.resolveViaImport({ fromNodeId: 'caller', referenceName: query.name,
    referenceKind: query.namespace === 'type' ? 'type_of' : 'calls', filePath: `Consumer${queryIndex}.hs`,
    language: 'haskell', line: 2, column: 0 }, fixtureContext.context);
  return { target: result?.targetNodeId ?? null,
    exhausted: engine.api.__auditWalks.some(walk => walk.exhausted),
    walks: engine.api.__auditWalks.length, routeReads: fixtureContext.reads() };
}

function main() {
  const baseline = loadEngine(options.baseline), candidate = loadEngine(options.candidate);
  if (baseline.sha256 === candidate.sha256) throw new Error('Candidate dist equals frozen baseline; rebuild candidate first');
  let oracle;
  const summary = { cases: 0, graphs: 0, baselineComplete: 0, baselineExhausted: 0,
    oldTargets: 0, preservedOldTargets: 0, completedComparisons: 0, mismatches: 0,
    oracleComparisons: 0, oracleExhausted: 0, newTargetsVerified: 0, unverifiedNewTargets: 0,
    bothIncompleteOrUnresolved: 0, warmChecks: 0, warmMismatches: 0, maxModules: 0 };
  const families = {}, failures = [], skipped = [];
  const recordFailure = (reason, input, query, before, after, oracleResult) => {
    summary.mismatches++;
    if (failures.length < 12) failures.push({ reason, fixture: input, query, baseline: before,
      candidate: after, ...(oracleResult ? { oracle: oracleResult } : {}) });
  };
  for (let serial = 0; serial < options.cases / 2; serial++) {
    const input = fixture(serial), oldContext = makeContext(input), newContext = makeContext(input);
    summary.graphs++; summary.maxModules = Math.max(summary.maxModules, input.moduleCount);
    families[input.family] = (families[input.family] || 0) + 1;
    for (let query = 0; query < 2; query++) {
      summary.cases++;
      // A memoized exhausted result has no new audit marker. Force baseline
      // queries cold so "complete" always describes an observed fresh walk.
      baseline.api.clearImportResolverMemos(oldContext.context);
      const before = resolve(baseline, oldContext, input, query), after = resolve(candidate, newContext, input, query);
      if (before.target) { summary.oldTargets++; if (after.target === before.target) summary.preservedOldTargets++; }
      if (!before.exhausted) {
        summary.baselineComplete++; summary.completedComparisons++;
        if (before.target !== after.target) recordFailure('Completed baseline answer changed', input, query, before, after);
      } else {
        summary.baselineExhausted++;
        if (before.target && before.target !== after.target) recordFailure('Previously resolved target lost', input, query, before, after);
        if (after.target && after.target !== before.target) {
          oracle ??= loadEngine(options.baseline, true);
          const oracleContext = makeContext(input), answer = resolve(oracle, oracleContext, input, query);
          summary.oracleComparisons++;
          if (answer.exhausted) {
            summary.oracleExhausted++; summary.unverifiedNewTargets++;
            if (skipped.length < 12) skipped.push({ serial, seed: input.seed, query, reason: 'Expanded baseline oracle exhausted' });
          } else if (answer.target !== after.target) {
            recordFailure('New target disagrees with completed baseline oracle', input, query, before, after, answer);
          } else summary.newTargetsVerified++;
          oracle.api.clearImportResolverMemos(oracleContext.context);
        } else summary.bothIncompleteOrUnresolved++;
      }
      const warm = resolve(candidate, newContext, input, query);
      summary.warmChecks++;
      if (warm.target !== after.target) { summary.warmMismatches++; recordFailure('Warm candidate answer changed', input, query, after, warm); }
    }
    baseline.api.clearImportResolverMemos(oldContext.context);
    candidate.api.clearImportResolverMemos(newContext.context);
  }
  const passed = summary.mismatches === 0 && summary.unverifiedNewTargets === 0
    && summary.completedComparisons >= options.cases * 0.9;
  if (!passed) process.exitCode = 1;
  return { schemaVersion: 1, completed: true, passed, purpose: 'Correctness differential, not a performance benchmark',
    engines: { frozenResolverSha256: baseline.sha256, candidateResolverSha256: candidate.sha256 },
    method: { seed: 'xorshift32: 0x19092026 xor imul(graph+1,0x9e3779b1)',
      baselineVisitBudget: 10000, oracleVisitBudget: 200000, depthBudgetUnchanged: 64,
      oracle: 'Frozen resolver modified only in memory; used only to certify newly resolved targets after baseline exhaustion',
      exclusions: 'Both unresolved when baseline exhausted are counted separately, not counted as completed equivalence checks',
      minimumCompletedComparisonsFraction: 0.9, independentContextsPerEngine: true,
      baselineCachesClearedBeforeEachQuery: true,
      realCorpusReads: false, engineFilesModified: false, fixturesAreResolverMetadata: true },
    summary, familyNames: ['named-renames', 'dense-negative-DAG', 'cycle-with-optional-exit', 'parent-union',
      'hiding', 'type-value-namespaces', 'operators', 'package-qualified', 'parent-reset',
      'converging-restricted-paths', 'missing-module', 'seeded-mixed-graph'],
    familyGraphCounts: families, failures, skipped };
}

// All generators and constants must be initialized before worker execution.
if (options.worker) {
  try { console.log(JSON.stringify(main())); }
  catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, completed: false, passed: false,
      error: sanitize(String(error?.message ?? error)) }));
    process.exitCode = 1;
  }
}

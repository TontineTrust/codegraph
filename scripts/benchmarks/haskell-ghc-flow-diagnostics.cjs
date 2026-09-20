#!/usr/bin/env node
// Read-only diagnostic of an inactive index; never open/heal/sync the source DB.
// node scripts/benchmarks/haskell-ghc-flow-diagnostics.cjs ENGINE_ROOT INDEXED_CORPUS_ROOT OPTIONS_JSON NEW_OUTPUT_JSON
// First run actual explore. For the separate resolver probe, then set
// GHC_RESOLVER_PROBE=1 GHC_EXPLORE_EVIDENCE=/path/to/the/completed/explore.json.
// Resolver instrumentation requires the audit export-walk marker in the built engine.
// Keep the indexed corpus stopped throughout both calls; DB+WAL are copied internally.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const [engineArg, rootArg, optionsArg, outputArg, scratch] = process.argv.slice(2);
if (!outputArg) throw new Error('Usage: node scripts/benchmarks/haskell-ghc-flow-diagnostics.cjs ENGINE_ROOT INDEXED_CORPUS_ROOT OPTIONS_JSON NEW_OUTPUT_JSON');
const engine = fs.realpathSync(engineArg), root = fs.realpathSync(rootArg);
const output = path.join(fs.realpathSync(path.dirname(path.resolve(outputArg))), path.basename(outputArg));
const rel = path.relative(root, output);
if (!rel || (!rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) throw new Error('Output inside corpus refused');
if (fs.existsSync(output)) throw new Error('Existing report refused');
const options = JSON.parse(fs.readFileSync(optionsArg, 'utf8'));
if (!Array.isArray(options.queries) || options.queries.length !== 3) throw new Error('Exactly three queries required');
const dbPath = path.join(root, '.codegraph/codegraph.db');
const maxBytes = 1024 ** 3;
const sourcePaths = [dbPath, dbPath + '-wal'];
const totalBytes = sourcePaths.reduce((sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
if (totalBytes > maxBytes) throw new Error('Combined database/WAL exceed 1 GiB guard');
if (!scratch) {
  const temp = fs.mkdtempSync(path.join(path.dirname(output), '.ghc-flow-'));
  try {
    const child = spawnSync(process.execPath, ['--max-old-space-size=512', __filename,
      engine, root, path.resolve(optionsArg), output, temp], {
      env: { ...process.env, CODEGRAPH_KERNEL: '0', CODEGRAPH_TELEMETRY: '0' },
      encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error || child.status !== 0) {
      const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { root, engine };
      Object.assign(report, { completed: false, workerError: String(child.error ?? `Exit ${child.status}`), signal: child.signal });
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      process.exitCode = child.status || 1;
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
} else void run();

function fingerprint(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file), hash = crypto.createHash('sha256');
  if (stat.size > maxBytes) throw new Error('Growing file exceeds guard');
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(256 * 1024);
  try {
    let bytes, read = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      if ((read += bytes) > maxBytes) throw new Error('Growing file exceeds guard');
      hash.update(buffer.subarray(0, bytes));
    }
    return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function actualFlow(text) {
  const heading = '**Flow (call path among the symbols you queried)**', lines = text.split('\n');
  const start = lines.findIndex(line => line.trim() === heading);
  if (start < 0) return { present: false, text: '', steps: 0, truncated: false };
  const compact = [heading]; let steps = 0;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (/^\d+\. .+ \(.+:\d+\)$/.test(line)) { compact.push(line); steps++; }
    else if (/^\s*↓ /.test(line)) compact.push(line.replace(/ \(when .*/, ''));
    else break;
  }
  const full = compact.join('\n');
  return { present: true, text: full.slice(0, 6000), steps, truncated: full.length > 6000 };
}
async function run() {
  const started = performance.now();
  const report = { root, engine, startedAt: new Date().toISOString(), node: process.version,
    completed: false, indexCompletion: 'Unverified until persisted index-state metadata is read; no completion assumed',
    opening: 'isolated main DB plus WAL copy; native readOnly adapter; no migration/heal/index/sync',
    limits: { timeoutMs: 30000, maxHeapMiB: 512, maxCombinedDbWalBytes: maxBytes, maxStoredResponseChars: 65536 },
    phase: 'snapshot', flows: [], before: sourcePaths.map(fingerprint) };
  const checkpoint = () => { report.elapsedMs = performance.now() - started; fs.writeFileSync(output, JSON.stringify(report, null, 2)); };
  checkpoint();
  let db;
  try {
    const snapshot = path.join(scratch, 'codegraph.db');
    for (const suffix of ['', '-wal']) if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, snapshot + suffix, fs.constants.COPYFILE_EXCL);
    if (sourcePaths.map((_, i) => fingerprint(snapshot + (i ? '-wal' : ''))?.sha256 ?? null).some((hash, i) => hash !== (report.before[i]?.sha256 ?? null))) throw new Error('Snapshot content mismatch');
    const { createDatabase } = require(path.join(engine, 'dist/db/sqlite-adapter.js'));
    const { DatabaseConnection } = require(path.join(engine, 'dist/db/index.js'));
    const { QueryBuilder } = require(path.join(engine, 'dist/db/queries.js'));
    const { CodeGraph } = require(path.join(engine, 'dist/index.js'));
    const { ToolHandler } = require(path.join(engine, 'dist/mcp/tools.js'));
    const opened = createDatabase(snapshot, { readOnly: true }); db = opened.db;
    db.pragma('query_only = ON');
    let fts = true; try { db.prepare('SELECT * FROM nodes_fts LIMIT 0').get(); } catch { fts = false; }
    DatabaseConnection.open = () => { throw new Error('Readonly diagnostic forbids lifecycle reopen'); };
    const graph = new CodeGraph(new DatabaseConnection(db, snapshot, opened.backend, fts), new QueryBuilder(db), root);
    // CodeGraph FIRST: ask actual explore before using exact-node SQL for diagnosis.
    report.phase = 'actual-explore'; checkpoint();
    for (const query of (process.env.GHC_RESOLVER_PROBE === '1' ? [] : options.queries)) {
      const at = performance.now(), response = await new ToolHandler(graph).execute('codegraph_explore', { query });
      const text = response.content?.map(item => item.text ?? '').join('\n') ?? '';
      report.flows.push({ query, exploreMs: performance.now() - at, isError: response.isError ?? false,
        surfacedFlow: actualFlow(text), chars: text.length, outputTruncated: /output truncated/i.test(text),
        storedResponseTruncated: text.length > 65536, responseText: text.slice(0, 65536) }); checkpoint();
    }
    report.phase = 'stored-evidence'; checkpoint();
    report.metadata = db.prepare('SELECT key,value FROM project_metadata ORDER BY key LIMIT 101').all();
    report.indexState = report.metadata.find(row => row.key === 'index_state')?.value ?? null;
    report.indexCompletion = report.indexState === 'complete'
      ? 'Complete marker observed; benchmark termination and success must still be checked separately'
      : `Not confirmed complete: persisted index_state=${report.indexState}`;
    report.pendingStatus = db.prepare('SELECT status,COUNT(*) AS count FROM unresolved_refs GROUP BY status').all();
    const names = [...new Set(options.queries.flatMap(query => query.split(' ')))];
    const marks = names.map(() => '?').join(',');
    report.nodes = db.prepare(`SELECT id,name,kind,qualified_name,file_path,start_line,end_line,is_exported FROM nodes WHERE name IN (${marks}) ORDER BY name,file_path,start_line LIMIT 201`).all(...names);
    report.nodesTruncated = report.nodes.length > 200;
    const ids = report.nodes.slice(0, 200).map(node => node.id), idMarks = ids.map(() => '?').join(',');
    report.outgoingEdges = ids.length ? db.prepare(`SELECT e.*,n.name AS target_name,n.kind AS target_kind,n.file_path AS target_file,n.start_line AS target_line FROM edges e JOIN nodes n ON n.id=e.target WHERE e.source IN (${idMarks}) ORDER BY e.source,e.line,e.kind,e.target LIMIT 1001`).all(...ids) : [];
    report.outgoingEdgesTruncated = report.outgoingEdges.length > 1000;
    report.unresolvedReferences = ids.length ? db.prepare(`SELECT * FROM unresolved_refs WHERE from_node_id IN (${idMarks}) ORDER BY from_node_id,line,reference_name LIMIT 1001`).all(...ids) : [];
    report.unresolvedReferencesTruncated = report.unresolvedReferences.length > 1000;
    const files = [...new Set(report.nodes.map(node => node.file_path))];
    report.files = files.length ? db.prepare(`SELECT path,size,node_count,errors FROM files WHERE path IN (${files.map(() => '?').join(',')}) ORDER BY path`).all(...files) : [];
    if (process.env.GHC_RESOLVER_PROBE === '1') {
      report.phase = 'fresh-resolver-probe'; checkpoint();
      const evidencePath = process.env.GHC_EXPLORE_EVIDENCE;
      if (!evidencePath) throw new Error('Resolver probe requires GHC_EXPLORE_EVIDENCE from a completed actual-explore diagnostic');
      if (fs.statSync(evidencePath).size > 2 * 1024 * 1024) throw new Error('Explore evidence exceeds 2 MiB guard');
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      if (!evidence.completed || evidence.root !== root || evidence.engine !== engine || evidence.flows?.length !== 3
        || JSON.stringify(evidence.after) !== JSON.stringify(report.before)) {
        throw new Error('Explore evidence does not match this engine, corpus, or preserved snapshot');
      }
      report.exploreFirstEvidence = path.resolve(evidencePath);
      const imports = require(path.join(engine, 'dist/resolution/import-resolver.js'));
      // Audit-only in-memory instrumentation: preserve returned values while
      // exposing whether an export walk failed closed on its work/depth limit.
      const Module = require('node:module');
      const moduleFile = path.join(engine, 'dist/resolution/import-resolver.js');
      const moduleSource = fs.readFileSync(moduleFile, 'utf8');
      const marker = 'return traversal.exhausted ? HASKELL_EXPORT_AMBIGUOUS : result;';
      if (moduleSource.split(marker).length !== 2) throw new Error('Expected exactly one export-walk diagnostic point');
      const tracedImports = new Module(moduleFile, module);
      tracedImports.filename = moduleFile;
      tracedImports.paths = Module._nodeModulePaths(path.dirname(moduleFile));
      tracedImports._compile(moduleSource.replace(marker,
        `exports.auditWalks.push({filePath, name:want.exportedName, remaining:traversal.remaining, exhausted:traversal.exhausted, ambiguous:result===HASKELL_EXPORT_AMBIGUOUS, target:result?.id ?? null}); ${marker}`), moduleFile);
      tracedImports.exports.auditWalks = [];
      const context = graph.resolver.context;
      const fromFile = 'compiler/GHC/Driver/Main/Passes.hs';
      const wanted = new Map([['tcRnModule', 'GHC.Tc.Module'], ['deSugar', 'GHC.HsToCore'], ['core2core', 'GHC.Core.Opt.Pipeline']]);
      report.importMappings = context.getImportMappings(fromFile, 'haskell');
      report.resolverProbes = [];
      const probeReferences = report.unresolvedReferences.filter(ref => ref.file_path === fromFile && wanted.has(ref.reference_name));
      report.expectedProbeCount = 3;
      if (probeReferences.length !== 3) report.probeWarning = 'Expected three preserved imported references; missing/resolved refs are not fabricated for this probe';
      for (const stored of probeReferences) {
        const ref = { fromNodeId: stored.from_node_id, referenceName: stored.reference_name, referenceKind: stored.reference_kind,
          line: stored.line, column: stored.col, filePath: stored.file_path, language: stored.language };
        const moduleName = wanted.get(ref.referenceName), at = performance.now();
        graph.resolver.clearCaches();
        const result = imports.resolveViaImport(ref, context);
        graph.resolver.clearCaches();
        tracedImports.exports.clearImportResolverMemos(context);
        tracedImports.exports.auditWalks = [];
        const instrumentedResult = tracedImports.exports.resolveViaImport(ref, context);
        const walks = tracedImports.exports.auditWalks;
        report.resolverProbes.push({ ref, storedStatus: stored.status, ms: performance.now() - at, result,
          instrumentedResult, exportWalks: walks,
          moduleName, modulePath: imports.resolveImportPath(moduleName, fromFile, 'haskell', context),
          namespaces: context.getNodesByName(moduleName).map(node => ({ id: node.id, name: node.name, kind: node.kind, filePath: node.filePath })),
          targets: context.getNodesByName(ref.referenceName).map(node => ({ id: node.id, name: node.name, kind: node.kind, filePath: node.filePath, isExported: node.isExported })),
        }); checkpoint();
      }
    }
    report.completed = true;
  } catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
  finally {
    try { db?.close(); } catch (error) { report.closeError = String(error); process.exitCode = 1; }
    report.after = sourcePaths.map(fingerprint);
    report.databaseAndWalUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
    if (!report.databaseAndWalUnchanged) process.exitCode = 1;
    report.phase = 'done'; report.maxRSSKiB = process.resourceUsage().maxRSS; checkpoint();
    console.log(JSON.stringify({ output, completed: report.completed, elapsedMs: report.elapsedMs,
      databaseAndWalUnchanged: report.databaseAndWalUnchanged,
      flows: report.flows.map(({ query, isError, surfacedFlow, outputTruncated }) => ({ query, isError, surfacedFlow, outputTruncated })),
      pendingStatus: report.pendingStatus, nodes: report.nodes?.length,
      outgoingEdges: report.outgoingEdges?.length, unresolvedReferences: report.unresolvedReferences?.length,
      error: report.error }, null, 2));
  }
}

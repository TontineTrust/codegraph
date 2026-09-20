#!/usr/bin/env node
// Read-only replay over an EXISTING xmonad index. No open/init/sync/server lifecycle.
// Keep the corpus stopped; a nonempty WAL is refused. The DB is copied internally.
// Usage: node scripts/benchmarks/haskell-supplemental-flows.cjs ENGINE_ROOT INDEXED_CORPUS_ROOT NEW_OUTPUT_JSON
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');

const [engineArg, rootArg, outputArg, workerFlag] = process.argv.slice(2);
if (!engineArg || !rootArg || !outputArg || (workerFlag && workerFlag !== '--readonly-worker')) {
  throw new Error('Usage: node scripts/benchmarks/haskell-supplemental-flows.cjs ENGINE_ROOT INDEXED_CORPUS_ROOT NEW_OUTPUT_JSON');
}
const engine = fs.realpathSync(engineArg), root = fs.realpathSync(rootArg);
// Require an existing output parent, and resolve symlinks before the containment check.
const output = path.join(fs.realpathSync(path.dirname(path.resolve(outputArg))), path.basename(outputArg));
const relativeOutput = path.relative(root, output);
if (!relativeOutput || (!relativeOutput.startsWith('..' + path.sep) && !path.isAbsolute(relativeOutput))) {
  throw new Error('Output must be outside the indexed corpus.');
}
if (fs.existsSync(output)) throw new Error('Refusing to overwrite an existing report.');
const dbPath = path.join(root, '.codegraph', 'codegraph.db');
if (!fs.statSync(dbPath).isFile()) throw new Error('Existing corpus database required.');

if (workerFlag !== '--readonly-worker') {
  // A separate process bounds synchronous search too; an in-process timer cannot.
  const child = spawnSync(process.execPath, ['--max-old-space-size=512', __filename,
    engine, root, output, '--readonly-worker'], {
    env: { ...process.env, CODEGRAPH_KERNEL: '0', CODEGRAPH_TELEMETRY: '0' },
    encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error || child.status !== 0) {
    if (!fs.existsSync(output)) fs.writeFileSync(output, JSON.stringify({ engine, root,
      completed: false, error: String(child.error ?? `Worker exited ${child.status}`),
      signal: child.signal, limits: { timeoutMs: 30000, maxHeapMiB: 512 },
    }, null, 2), { flag: 'wx' });
    process.exitCode = child.status || 1;
  }
} else {
  void run();
}

// Same actual-response extraction as scripts/benchmarks/haskell-corpus.cjs.
// In particular, do not replace absent surfaced Flow with an internal graph path.
function surfacedFlowFromExplore(text) {
  const heading = '**Flow (call path among the symbols you queried)**';
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.trim() === heading);
  if (start < 0) return { present: false, text: '', steps: 0, truncated: false };
  const compact = [heading];
  let steps = 0;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (/^\d+\. .+ \(.+:\d+\)$/.test(line)) { compact.push(line); steps++; }
    else if (/^\s*↓ /.test(line)) compact.push(line.replace(/ \(when .*/, ''));
    else break;
  }
  const compactText = compact.join('\n'), limit = 6000;
  return { present: true, text: compactText.slice(0, limit), steps, truncated: compactText.length > limit };
}

function fingerprint(file) {
  if (!fs.existsSync(file)) return null;
  const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    const stats = fs.fstatSync(fd);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return { size: stats.size, mtimeMs: stats.mtimeMs, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}

async function run() {
  const started = performance.now();
  const report = { engine, root, node: process.version, startedAt: new Date().toISOString(),
    completed: false, readOnly: true, opening: 'native readOnly adapter on an isolated copy of the checkpointed database; existing connection/graph constructors; no lifecycle open, migration, heal, or sync',
    limits: { timeoutMs: 30000, maxHeapMiB: 512, maxDatabaseBytes: 100 * 1024 * 1024, maxStoredResponseChars: 65536, queries: 4 },
    flows: [], before: { database: fingerprint(dbPath), wal: fingerprint(dbPath + '-wal') },
  };
  let db, scratch;
  try {
    if (report.before.database.size > report.limits.maxDatabaseBytes) throw new Error('Database exceeds the bounded checker limit');
    if (report.before.wal?.size) throw new Error('Checkpointed inactive corpus required; refusing to copy a non-empty WAL');
    // SQLite readOnly still creates WAL/SHM sidecars for a WAL-mode database.
    // Isolate those coordination files too, while preserving the original root
    // for source reads and source-based ranking. Never open the corpus DB here.
    scratch = fs.mkdtempSync(path.join(path.dirname(output), '.flow-reader-'));
    const snapshot = path.join(scratch, 'codegraph.db');
    fs.copyFileSync(dbPath, snapshot, fs.constants.COPYFILE_EXCL);
    if (fingerprint(snapshot).sha256 !== report.before.database.sha256) throw new Error('Corpus database changed during snapshot');
    const { createDatabase } = require(path.join(engine, 'dist/db/sqlite-adapter.js'));
    const { DatabaseConnection } = require(path.join(engine, 'dist/db/index.js'));
    const { QueryBuilder } = require(path.join(engine, 'dist/db/queries.js'));
    const { CodeGraph } = require(path.join(engine, 'dist/index.js'));
    const { ToolHandler } = require(path.join(engine, 'dist/mcp/tools.js'));
    const opened = createDatabase(snapshot, { readOnly: true });
    db = opened.db;
    db.pragma('query_only = ON');
    let fts5Available = true;
    try { db.prepare('SELECT * FROM nodes_fts LIMIT 0').get(); } catch { fts5Available = false; }
    // TS-private constructors remain callable in compiled JS. This audit-only
    // injection preserves real query/ToolHandler behavior without mutable open().
    DatabaseConnection.open = () => { throw new Error('Reopening disabled in the read-only Flow checker'); };
    const connection = new DatabaseConnection(db, snapshot, opened.backend, fts5Available);
    const graph = new CodeGraph(connection, new QueryBuilder(db), root);
    for (const query of [
      'manage userCodeDef userCode',
      'XMonad.Operations.float floatLocation applySizeHintsContents',
      'windows catchX runX',
      'windows sendMessageWithNoRefresh updateLayout',
    ]) {
      const handler = new ToolHandler(graph), queryStarted = performance.now();
      const response = await handler.execute('codegraph_explore', { query });
      const text = response.content?.map(item => item.text ?? '').join('\n') ?? '';
      const truncationNotices = text.split('\n').filter(line => /output truncated/i.test(line));
      report.flows.push({ query, exploreMs: performance.now() - queryStarted, chars: text.length,
        isError: response.isError ?? false, surfacedFlow: surfacedFlowFromExplore(text),
        outputTruncated: truncationNotices.length > 0, truncationNotices,
        storedResponseTruncated: text.length > 65536, responseText: text.slice(0, 65536) });
    }
    report.completed = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
    process.exitCode = 1;
  } finally {
    try { db?.close(); } catch (error) { report.closeError = String(error); process.exitCode = 1; }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    report.after = { database: fingerprint(dbPath), wal: fingerprint(dbPath + '-wal') };
    report.databaseAndWalUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
    if (!report.databaseAndWalUnchanged) process.exitCode = 1;
    report.elapsedMs = performance.now() - started;
    report.maxRSSKiB = process.resourceUsage().maxRSS;
    fs.writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
    process.stdout.write(JSON.stringify({ output, completed: report.completed,
      databaseAndWalUnchanged: report.databaseAndWalUnchanged,
      flows: report.flows.map(({ query, isError, surfacedFlow, outputTruncated, storedResponseTruncated }) =>
        ({ query, isError, surfacedFlow, outputTruncated, storedResponseTruncated })) }, null, 2) + '\n');
  }
}

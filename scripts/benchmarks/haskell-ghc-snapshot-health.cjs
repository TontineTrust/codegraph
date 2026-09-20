#!/usr/bin/env node
// Run after the benchmark matrix has stopped, on inactive inputs.
// node scripts/benchmarks/haskell-ghc-snapshot-health.cjs INDEXED_CORPUS_ROOT NEW_OUTPUT_JSON
// Native SQLite opens ONLY a disposable DB+WAL copy; no CodeGraph lifecycle.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const [rootArg, outputArg, scratch] = process.argv.slice(2);
if (!rootArg || !outputArg) throw new Error('Usage: node scripts/benchmarks/haskell-ghc-snapshot-health.cjs INDEXED_CORPUS_ROOT NEW_OUTPUT_JSON');
const root = fs.realpathSync(rootArg);
const output = path.join(fs.realpathSync(path.dirname(path.resolve(outputArg))), path.basename(outputArg));
const rel = path.relative(root, output);
if (!rel || (!rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) throw new Error('Output must be outside corpus');
if (fs.existsSync(output)) throw new Error('Existing report refused');
const dbPath = path.join(root, '.codegraph/codegraph.db');
const maxBytes = 1024 ** 3;
const sourcePaths = [dbPath, dbPath + '-wal'];
const limits = { timeoutMs: 30000, maxHeapMiB: 512, maxCombinedDbWalBytes: maxBytes,
  sqliteCacheKiB: 32768, mmapBytes: 0, maxIntegrityErrors: 100, maxForeignKeyErrors: 100,
  maxFileRecords: 50000, maxFileExamples: 100, maxStoredErrorChars: 4000 };
const stamps = () => sourcePaths.map(file => {
  if (!fs.existsSync(file)) return null;
  const s = fs.statSync(file);
  if (!s.isFile()) throw new Error('Database and WAL must be regular files');
  return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino, dev: s.dev };
});

if (!scratch) {
  const before = stamps();
  if (!before[0]) throw new Error('Existing main database required');
  const bytes = before.reduce((sum, s) => sum + (s?.size ?? 0), 0);
  if (bytes > maxBytes) {
    fs.writeFileSync(output, JSON.stringify({ root, completed: false, refused: 'Combined DB+WAL exceed 1 GiB', limits, before }, null, 2), { flag: 'wx' });
    process.exitCode = 2;
  } else {
    const temp = fs.mkdtempSync(path.join(path.dirname(output), '.ghc-health-'));
    try {
      const child = spawnSync(process.execPath, ['--max-old-space-size=512', __filename, root, output, temp], {
        env: { ...process.env, CODEGRAPH_KERNEL: '0', CODEGRAPH_TELEMETRY: '0' },
        encoding: 'utf8', timeout: limits.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      if (child.error || child.status !== 0) {
        const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { root, limits };
        Object.assign(report, { completed: false, workerError: String(child.error ?? `Exit ${child.status}`), signal: child.signal,
          parentBefore: before, parentAfter: stamps() });
        report.parentStampsUnchanged = JSON.stringify(report.parentBefore) === JSON.stringify(report.parentAfter);
        // On timeout a completed SHA verification may be unavailable. Never
        // promote stable stat fields into a claimed hash/integrity success.
        fs.writeFileSync(output, JSON.stringify(report, null, 2));
        process.exitCode = child.status || 1;
      }
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
} else run();

function fingerprint(file) {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Source size/type changed beyond guard');
    let bytes, total = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      if ((total += bytes) > maxBytes) throw new Error('Growing source exceeds guard');
      hash.update(buffer.subarray(0, bytes));
    }
    return { size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function run() {
  const start = performance.now();
  const report = { root, startedAt: new Date().toISOString(), node: process.version,
    completed: false, limits, phase: 'snapshot', checks: [],
    interpretation: 'Preserved snapshot storage diagnostics only: incomplete index-state markers prevent completed semantic-parity claims. No row-exact comparison.',
    before: sourcePaths.map(fingerprint) };
  const checkpoint = () => {
    report.elapsedMs = performance.now() - start;
    const tempReport = path.join(scratch, 'report.json');
    fs.writeFileSync(tempReport, JSON.stringify(report, null, 2));
    fs.renameSync(tempReport, output);
  };
  checkpoint();
  let db;
  try {
    if (report.before.reduce((sum, f) => sum + (f?.size ?? 0), 0) > maxBytes) throw new Error('Growing combined input exceeds guard');
    const snapshot = path.join(scratch, 'codegraph.db');
    for (const suffix of ['', '-wal']) if (fs.existsSync(dbPath + suffix)) {
      fs.copyFileSync(dbPath + suffix, snapshot + suffix, fs.constants.COPYFILE_EXCL);
    }
    const copied = [snapshot, snapshot + '-wal'].map(fingerprint);
    if (copied.some((f, i) => f?.sha256 !== report.before[i]?.sha256)) throw new Error('Snapshot hashes differ from source');
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(snapshot, { readOnly: true });
    db.exec('PRAGMA query_only=ON');
    db.exec(`PRAGMA cache_size=-${limits.sqliteCacheKiB}`);
    db.exec('PRAGMA mmap_size=0');
    db.exec('PRAGMA busy_timeout=1000');
    const check = (name, fn) => {
      report.phase = name; checkpoint();
      const at = performance.now(), value = fn();
      report.checks.push({ name, ms: performance.now() - at, value }); checkpoint();
      return value;
    };
    check('metadata', () => db.prepare('SELECT key,value FROM project_metadata ORDER BY key LIMIT 101').all());
    check('page-storage', () => {
      const pragma = name => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
      const pageSize = pragma('page_size'), pageCount = pragma('page_count'), freelistCount = pragma('freelist_count');
      return { pageSize, pageCount, freelistCount, logicalBytes: pageSize * pageCount,
        journalMode: pragma('journal_mode'),
        meaning: 'Logical committed pages including copied WAL; physical DB+WAL sizes are reported separately. No checkpoint/VACUUM performed.' };
    });
    check('record-counts', () => ({
      nodes: db.prepare('SELECT COUNT(*) AS count FROM nodes').get().count,
      edges: db.prepare('SELECT COUNT(*) AS count FROM edges').get().count,
      files: db.prepare('SELECT COUNT(*) AS count FROM files').get().count,
      referencesByStatus: db.prepare('SELECT status,COUNT(*) AS count FROM unresolved_refs GROUP BY status').all(),
    }));
    const integrity = check('integrity_check', () => {
      const rows = db.prepare(`PRAGMA integrity_check(${limits.maxIntegrityErrors})`).all();
      const messages = rows.map(row => String(Object.values(row)[0]));
      return { ok: messages.length === 1 && messages[0] === 'ok', messages,
        errorLimitReached: messages.length >= limits.maxIntegrityErrors };
    });
    const foreignKeys = check('foreign_key_check', () => {
      const examples = []; let observed = 0, truncated = false;
      for (const row of db.prepare('PRAGMA foreign_key_check').iterate()) {
        observed++;
        if (observed > limits.maxForeignKeyErrors) { truncated = true; break; }
        examples.push(row);
      }
      return { ok: observed === 0, observed, truncated, examples,
        countMeaning: truncated ? 'Lower bound; stopped after diagnostic cap' : 'Complete violation count' };
    });
    const orphans = check('orphan-counts', () => ({
      edgesMissingSource: db.prepare('SELECT COUNT(*) AS count FROM edges e WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=e.source)').get().count,
      edgesMissingTarget: db.prepare('SELECT COUNT(*) AS count FROM edges e WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=e.target)').get().count,
      referencesMissingSource: db.prepare('SELECT COUNT(*) AS count FROM unresolved_refs r WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=r.from_node_id)').get().count,
      nodesWithoutFileRecord: db.prepare('SELECT COUNT(*) AS count FROM nodes n WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.path=n.file_path)').get().count,
      filesWithoutNodes: db.prepare('SELECT COUNT(*) AS count FROM files f WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.file_path=f.path)').get().count,
      caveat: 'Missing node endpoints are integrity defects; node/file record mismatches need interpretation (synthetic nodes, skipped files, interrupted stores), not automatic semantic-failure labels.',
    }));
    check('file-diagnostics', () => {
      const result = { scanned: 0, truncated: false, byLanguage: Object.create(null), generated: 0, zeroNodeRecords: 0,
        negativeSizeRecords: 0, filesWithErrors: 0, malformedErrorJson: 0, oversizedErrorJson: 0,
        byErrorCode: Object.create(null), examples: [], examplesTruncated: false };
      const sql = 'SELECT path,language,size,node_count,generated,errors FROM files ORDER BY path';
      for (const row of db.prepare(sql).iterate()) {
        if (result.scanned >= limits.maxFileRecords) { result.truncated = true; break; }
        result.scanned++;
        result.byLanguage[row.language] = (result.byLanguage[row.language] ?? 0) + 1;
        if (row.generated) result.generated++;
        if (row.node_count === 0) result.zeroNodeRecords++;
        if (row.size < 0) result.negativeSizeRecords++;
        let errors = [], hasDiagnostics = false;
        if (row.errors !== null && row.errors !== '') {
          if (row.errors.length > 65536) { result.oversizedErrorJson++; hasDiagnostics = true; }
          else {
            try { errors = JSON.parse(row.errors); if (!Array.isArray(errors)) throw new Error('Expected array'); hasDiagnostics = errors.length > 0; }
            catch { result.malformedErrorJson++; hasDiagnostics = true; errors = []; }
          }
        }
        if (hasDiagnostics) {
          result.filesWithErrors++;
          for (const error of errors) {
            const code = String(error?.code ?? '(no code)').slice(0, 80);
            result.byErrorCode[code] = (result.byErrorCode[code] ?? 0) + 1;
          }
          if (result.examples.length < limits.maxFileExamples) result.examples.push({
            path: row.path, size: row.size, nodeCount: row.node_count,
            errorsText: row.errors.slice(0, limits.maxStoredErrorChars),
            errorsTruncated: row.errors.length > limits.maxStoredErrorChars,
          }); else result.examplesTruncated = true;
        }
      }
      return result;
    });
    report.storageChecksPassed = integrity.ok && foreignKeys.ok
      && orphans.edgesMissingSource === 0 && orphans.edgesMissingTarget === 0 && orphans.referencesMissingSource === 0;
    report.completed = true;
  } catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
  finally {
    try { db?.close(); } catch (error) { report.closeError = String(error); process.exitCode = 1; }
    report.after = sourcePaths.map(fingerprint);
    report.databaseAndWalUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
    if (!report.databaseAndWalUnchanged) process.exitCode = 1;
    report.phase = 'done'; report.maxRSSKiB = process.resourceUsage().maxRSS; checkpoint();
    console.log(JSON.stringify({ output, completed: report.completed, storageChecksPassed: report.storageChecksPassed,
      databaseAndWalUnchanged: report.databaseAndWalUnchanged, elapsedMs: report.elapsedMs,
      completedChecks: report.checks.map(c => c.name), error: report.error }, null, 2));
  }
}

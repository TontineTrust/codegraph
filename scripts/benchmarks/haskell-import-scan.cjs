#!/usr/bin/env node
// Isolated hostile-input probe. Run engines serially; retain capped samples.
// node scripts/benchmarks/haskell-import-scan.cjs ENGINE_ROOT RESULT.json [normalize]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');

if (process.argv[2] === '--worker') {
  const [engine, rawSize, probe = 'imports'] = process.argv.slice(3);
  const size = Number(rawSize);
  const { extractHaskellImportSurface, normalizeHaskellReferenceName } = require(path.join(engine, 'dist/resolution/import-resolver.js'));
  const source = probe === 'normalize' ? '('.repeat(size) + 'map' + ')'.repeat(size) : [
    'module Adversarial (probe) where',
    'import Provider (helper)',
    `(${'-'.repeat(size)}+) x y = x`,
    'probe x = helper x',
    '',
  ].join('\n');
  const cpu = process.cpuUsage();
  const started = performance.now();
  const surface = probe === 'normalize'
    ? normalizeHaskellReferenceName(source)
    : extractHaskellImportSurface(source);
  const durationMs = performance.now() - started;
  if (probe === 'normalize' ? surface !== 'map'
    : !surface.imports.some((item) => item.source === 'Provider' && item.localName === 'helper')) {
    throw new Error(probe === 'normalize'
      ? 'Reference normalization changed in hostile-input probe'
      : 'Import visibility changed in hostile-input probe');
  }
  process.send({
    status: 'complete', size, bytes: Buffer.byteLength(source), durationMs,
    cpuMicros: process.cpuUsage(cpu), maxRssKiB: process.resourceUsage().maxRSS,
    ...(probe === 'normalize' ? { normalized: surface }
      : { importCount: surface.imports.length, reExportCount: surface.reExports.length }),
  });
  process.disconnect();
} else {
  const [rawEngine, rawOutput, probe = 'imports'] = process.argv.slice(2);
  if (!rawEngine || !rawOutput || !['imports', 'normalize'].includes(probe)) {
    throw new Error('Usage: haskell-import-scan.cjs ENGINE_ROOT RESULT.json [normalize]');
  }
  const engine = path.resolve(rawEngine);
  const output = path.resolve(rawOutput);
  const descriptor = fs.openSync(output, 'wx');
  fs.closeSync(descriptor);
  const report = { engine, probe, node: process.version, timeoutMs: 3000, repetitions: 3, samples: [] };
  const checkpoint = () => fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  checkpoint();
  const sample = (size, iteration) => new Promise((resolve) => {
    const child = fork(__filename, ['--worker', engine, String(size), probe], {
      execArgv: ['--max-old-space-size=256'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result;
    let stderr = '';
    const started = performance.now();
    let capped = false;
    const timer = setTimeout(() => { capped = true; child.kill('SIGKILL'); }, report.timeoutMs);
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
    child.on('message', (message) => { result = message; });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        size, iteration, ...(result ?? { status: capped ? 'timeout' : 'failed' }),
        processMs: performance.now() - started, code, signal,
        ...(stderr ? { stderr } : {}),
      });
    });
  });
  (async () => {
    for (const size of [1024, 4096, 16384, 65536]) {
      for (let iteration = 1; iteration <= report.repetitions; iteration++) {
        const result = await sample(size, iteration);
        report.samples.push(result);
        checkpoint();
        process.stdout.write(`${size}\t${iteration}\t${result.status}\t${result.durationMs ?? result.processMs}\n`);
      }
    }
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

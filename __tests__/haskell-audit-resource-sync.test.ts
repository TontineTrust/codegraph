import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { transpileModule, ModuleKind } from 'typescript';
import { CodeGraph } from '../src';
import type { ExtractionOrchestrator } from '../src/extraction';
import type { QueryBuilder } from '../src/db/queries';
import { ReferenceResolver } from '../src/resolution';
import { MAX_FILE_SIZE, readSource, readSourceSync } from '../src/source-reader';

vi.mock('fs', async (original) => ({ ...await original<typeof fs>() }));
vi.mock('fs/promises', async (original) => ({ ...await original<typeof fsp>() }));

describe('Haskell audit: bounded source reads and interrupted synchronization', () => {
  let root: string;
  let graph: CodeGraph | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    graph?.destroy();
    graph = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  const setup = () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-audit-')));
    graph = CodeGraph.initSync(root);
    return graph;
  };
  const fingerprint = (current: CodeGraph) => {
    const { queries } = current as unknown as { queries: QueryBuilder };
    const nodes = queries.getAllNodes();
    const digest = (rows: string[]) => createHash('sha256').update(rows.sort().join('\n')).digest('hex');
    return {
      nodes: digest(nodes.map(({ updatedAt: _updated, ...node }) => JSON.stringify(node))),
      edges: digest(nodes.flatMap(({ id }) => current.getOutgoingEdges(id))
        .map((edge) => JSON.stringify(edge))),
    };
  };
  const freshFingerprint = async () => {
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-audit-fresh-'));
    let fresh: CodeGraph | undefined;
    try {
      for (const name of fs.readdirSync(root).filter((name) => name.endsWith('.hs'))) {
        fs.copyFileSync(path.join(root, name), path.join(freshRoot, name));
      }
      fresh = CodeGraph.initSync(freshRoot);
      expect((await fresh.indexAll()).success).toBe(true);
      return fingerprint(fresh);
    } finally {
      fresh?.close();
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }
  };

  it.each(['indexAll', 'indexFiles', 'sync', 'getChangedFiles'] as const)(
    '%s does not read the contents of a known oversized source', async (operation) => {
      const current = setup();
      const file = path.join(root, 'Oversized.hs');
      fs.writeFileSync(file, 'module Oversized where\n');
      fs.truncateSync(file, 2 * 1024 * 1024);
      const asyncRead = vi.spyOn(fsp, 'readFile');
      const syncRead = vi.spyOn(fs, 'readFileSync');
      if (operation === 'indexFiles') await current.indexFiles(['Oversized.hs']);
      else if (operation === 'getChangedFiles') current.getChangedFiles();
      else await current[operation]();
      const oversizedReads = [...asyncRead.mock.calls, ...syncRead.mock.calls]
        .filter(([filePath]) => String(filePath) === file);
      expect(oversizedReads).toEqual([]);
      if (operation !== 'getChangedFiles') {
        expect(current.getFiles().find(({ path: p }) => p === 'Oversized.hs')?.errors?.[0]?.code)
          .toBe('size_exceeded');
        expect((await current.sync()).filesModified).toBe(0);
      }
    },
  );

  it('refreshes oversized markers and indexes a source once it fits again', async () => {
    const current = setup();
    const file = path.join(root, 'Oversized.hs');
    fs.writeFileSync(file, 'module Oversized where\n');
    fs.truncateSync(file, 2 * MAX_FILE_SIZE);
    await current.sync();
    expect(current.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
    const before = current.getFiles()[0]!;
    const changedTime = new Date(before.modifiedAt + 2000);
    fs.utimesSync(file, changedTime, changedTime);
    expect(current.getChangedFiles().modified).toEqual(['Oversized.hs']);
    expect((await current.sync()).filesModified).toBe(1);
    expect(current.getFiles()[0]!.contentHash).not.toBe(before.contentHash);
    expect(current.getChangedFiles().modified).toEqual([]);
    fs.writeFileSync(file, 'module Oversized where\nrecovered = 42\n');
    expect((await current.sync()).filesModified).toBe(1);
    expect(current.getNodesByName('recovered')).toHaveLength(1);
    expect(current.getFiles()[0]!.errors).toBeUndefined();
    expect((await current.sync()).filesModified).toBe(0);
  });

  it('accepts a source exactly at the byte limit without truncating UTF-8', async () => {
    setup();
    const file = path.join(root, 'Boundary.hs');
    const content = 'x'.repeat(MAX_FILE_SIZE - 4) + 'éé';
    fs.writeFileSync(file, content);
    expect((await readSource(file)).content).toBe(content);
    expect(readSourceSync(file).content).toBe(content);
  });

  it('bounds async reads when a source grows after fstat', async () => {
    setup();
    const file = path.join(root, 'Growing.hs');
    fs.writeFileSync(file, 'module Growing where\n');
    const open = fsp.open;
    let bytesRead = 0;
    vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) !== file) return handle;
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const initial = await stat();
        fs.truncateSync(file, 2 * MAX_FILE_SIZE);
        return initial;
      });
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
        const result = await (read as any)(...readArgs);
        bytesRead += result.bytesRead;
        return result;
      });
      return handle;
    });
    const source = await readSource(file);
    expect(source.content).toBe('');
    expect(source.stats.size).toBeGreaterThan(MAX_FILE_SIZE);
    expect(bytesRead).toBe(MAX_FILE_SIZE + 1);
  });

  it('bounds synchronous reads when a source grows after fstat', () => {
    setup();
    const file = path.join(root, 'Growing.hs');
    fs.writeFileSync(file, 'module Growing where\n');
    const stat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd, ...args) => {
      const initial = stat(fd, ...args);
      fs.truncateSync(file, 2 * MAX_FILE_SIZE);
      return initial;
    });
    const read = vi.spyOn(fs, 'readSync');
    const source = readSourceSync(file);
    expect(source.content).toBe('');
    expect(source.stats.size).toBeGreaterThan(MAX_FILE_SIZE);
    expect(read.mock.results.reduce((total, result) => total + Number(result.value), 0))
      .toBe(MAX_FILE_SIZE + 1);
  });

  it('refuses lexical resolver escapes and does not cache oversized source text', () => {
    const current = setup();
    const { queries } = current as unknown as { queries: QueryBuilder };
    const resolver = new ReferenceResolver(root, queries) as unknown as {
      readFileCached(file: string): string | null;
      clearCaches(): void;
    };
    const outside = `${root}-outside.hs`;
    try {
      fs.writeFileSync(outside, 'module Outside where\nsecret = 987654321\n');
      expect(resolver.readFileCached(path.relative(root, outside))).toBeNull();
      const file = path.join(root, 'Large.hs');
      fs.writeFileSync(file, 'module Large where\n');
      fs.truncateSync(file, 2 * MAX_FILE_SIZE);
      expect(resolver.readFileCached('Large.hs')).toBeNull();
      fs.writeFileSync(file, 'module Large where\nrestored = 1\n');
      resolver.clearCaches();
      expect(resolver.readFileCached('Large.hs')).toContain('restored');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('rejects a FIFO without waiting for a writer', () => {
    setup();
    const fifo = path.join(root, 'Hostile.hs');
    execFileSync('mkfifo', [fifo]);
    const reader = path.join(root, 'reader.cjs');
    fs.writeFileSync(reader, transpileModule(fs.readFileSync(path.resolve('src/source-reader.ts'), 'utf8'), {
      compilerOptions: { module: ModuleKind.CommonJS },
    }).outputText);
    // Keep the hostile read in a killable child even if the guard regresses.
    const script = `const {readSourceSync,readSource}=require(${JSON.stringify(reader)});
      const file=process.argv[1];
      try { readSourceSync(file); process.exit(2); } catch(error) {
        if (!/not a regular file/.test(error.message)) throw error;
      }
      readSource(file).then(()=>process.exit(3), error=> {
        if (!/not a regular file/.test(error.message)) throw error;
      });`;
    execFileSync(process.execPath, ['--eval', script, fifo], { timeout: 5000 });
  });

  it.each(['sync', 'indexAll'] as const)('recovers warmed Haskell caches after %s commits extraction then throws', async (operation) => {
    const current = setup();
    const write = (file: string, text: string) => fs.writeFileSync(path.join(root, file), text);
    write('Target.hs', 'module Target (oldTarget) where\noldTarget = 1\n');
    write('Caller.hs', 'module Caller where\nimport Target\nrun = oldTarget\n');
    await current.indexAll();
    await current.resolveReferencesBatched();
    write('Target.hs', 'module Target (freshTarget) where\nfreshTarget = 2\n');
    write('Caller.hs', 'module Caller where\nimport Target\nrun = freshTarget\n');
    const { orchestrator } = current as unknown as { orchestrator: ExtractionOrchestrator };
    const original = orchestrator[operation].bind(orchestrator);
    const spy = vi.spyOn(orchestrator, operation).mockImplementation(async (...args: any[]) => {
      await (original as (...args: any[]) => Promise<unknown>)(...args);
      throw new Error('injected post-store interruption');
    });
    await expect(current[operation]()).rejects.toThrow('injected post-store interruption');
    spy.mockRestore();
    expect(current.getPendingReferenceCount()).toBeGreaterThan(0);
    const recovered = await current.sync();
    expect(recovered.filesAdded + recovered.filesModified + recovered.filesRemoved).toBe(0);
    const run = current.getNodesByName('run')[0]!;
    expect(current.getOutgoingEdges(run.id).map(({ target }) => current.getNode(target)?.name))
      .toContain('freshTarget');
    expect(fingerprint(current)).toEqual(await freshFingerprint());
  });

  it.each((['indexFiles', 'indexAll', 'sync'] as const).flatMap((operation) =>
    (['unchanged', 'replaced', 'removed'] as const).map((change) => ({ operation, change })),
  ))('recovers an interrupted $operation chunk store (source: $change)', async ({ operation, change }) => {
    const current = setup();
    const file = path.join(root, 'Target.hs');
    fs.writeFileSync(file, 'module Target where\nanchor x = x\n');
    fs.writeFileSync(path.join(root, 'Caller.hs'), 'module Caller where\nimport Target\nrun = anchor 1\n');
    await current.indexAll();
    const many = Array.from({ length: 2100 }, (_, i) => `generated${i} x = x`).join('\n');
    fs.writeFileSync(file, `module Target where\nanchor x = x\n${many}\n`);
    const { queries } = current as unknown as { queries: QueryBuilder };
    const insert = queries.insertNodes.bind(queries);
    const spy = vi.spyOn(queries, 'insertNodes').mockImplementation((nodes) => {
      insert(nodes);
      if (nodes.length >= 2000) throw new Error('injected chunk interruption');
    });
    await expect(operation === 'indexFiles' ? current.indexFiles(['Target.hs']) : current[operation]())
      .rejects.toThrow('injected chunk interruption');
    spy.mockRestore();
    expect(current.getFiles().find(({ path: p }) => p === 'Target.hs')?.errors?.[0]?.code)
      .toBe('store_incomplete');
    expect(current.getIndexState()).toBe('indexing');
    if (change === 'replaced') fs.writeFileSync(file, 'module Target where\nanchor x = x + 1\n');
    if (change === 'removed') fs.unlinkSync(file);
    await current.sync();
    const run = current.getNodesByName('run')[0]!;
    if (change === 'removed') expect.soft(queries.getNodesByFile('Target.hs').length).toBe(0);
    else expect.soft(current.getOutgoingEdges(run.id).map(({ target }) => current.getNode(target)?.name))
        .toContain('anchor');
    if (change !== 'unchanged') expect.soft(current.getNodesByName('generated0')).toHaveLength(0);
    expect(current.getPendingReferenceCount()).toBe(0);
    expect(current.getIndexState()).toBe('complete');
    expect(fingerprint(current)).toEqual(await freshFingerprint());
  });
});

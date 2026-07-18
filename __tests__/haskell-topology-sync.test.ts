import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Haskell topology-aware sync invalidation', () => {
  let tmpDir: string | undefined;
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const createGraph = async (files: Record<string, string>) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-topology-'));
    for (const [filePath, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmpDir, filePath), content);
    }
    graph = CodeGraph.initSync(tmpDir);
    await graph.indexAll();
    return graph;
  };

  const internals = (current: CodeGraph) => current as unknown as {
    orchestrator: { invalidateHaskellImportEdges(...args: unknown[]): number };
    db: { getDb(): { prepare(sql: string): { run(...params: unknown[]): unknown } } };
    queries: {
      getFileByPath(filePath: string): { contentHash: string; haskellTopologyHash?: string } | null;
      getMetadata(key: string): string | null;
    };
  };

  const callTarget = (current: CodeGraph) => {
    const run = current.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
    return current.getOutgoingEdges(run.id)
      .map((edge) => current.getNode(edge.target))
      .find((node) => node?.name === 'foo');
  };

  it('skips the broad replay for comment-only edits and keeps incoming edges current', async () => {
    const current = await createGraph({
      'Lib.hs': 'module Lib (foo) where\nfoo x = x\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    const before = privateState.queries.getFileByPath('Lib.hs')!;
    const oldTargetId = callTarget(current)!.id;
    const original = privateState.orchestrator.invalidateHaskellImportEdges
      .bind(privateState.orchestrator);
    let broadReplays = 0;
    privateState.orchestrator.invalidateHaskellImportEdges = (...args: unknown[]) => {
      broadReplays++;
      return original(...args);
    };

    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), [
      'module Lib (foo) where',
      '-- implementation note',
      'foo x = x',
      '',
    ].join('\n'));
    await current.sync();

    const after = privateState.queries.getFileByPath('Lib.hs')!;
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.haskellTopologyHash).toBe(before.haskellTopologyHash);
    expect(broadReplays).toBe(0);
    expect(privateState.queries.getMetadata('haskell_import_invalidation_pending')).toBe('0');
    expect(callTarget(current)!.id).not.toBe(oldTargetId);
    expect(callTarget(current)!.filePath).toBe('Lib.hs');
  });

  it('keeps the broad replay when an import/reexport topology changes', async () => {
    const current = await createGraph({
      'A.hs': 'module A (foo) where\nfoo x = x\n',
      'B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'Lib.hs': 'module Lib (foo) where\nimport A (foo)\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    const before = privateState.queries.getFileByPath('Lib.hs')!;
    const original = privateState.orchestrator.invalidateHaskellImportEdges
      .bind(privateState.orchestrator);
    let broadReplays = 0;
    privateState.orchestrator.invalidateHaskellImportEdges = (...args: unknown[]) => {
      broadReplays++;
      return original(...args);
    };

    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), 'module Lib (foo) where\nimport B (foo)\n');
    await current.sync();

    expect(privateState.queries.getFileByPath('Lib.hs')!.haskellTopologyHash)
      .not.toBe(before.haskellTopologyHash);
    expect(broadReplays).toBe(1);
    expect(callTarget(current)!.filePath).toBe('B.hs');
  });

  it('replays conservatively once for a migrated file without a fingerprint', async () => {
    const current = await createGraph({
      'Lib.hs': 'module Lib (foo) where\nfoo x = x\n',
      'Main.hs': 'module Main where\nimport Lib (foo)\nrun = foo 1\n',
    });
    const privateState = internals(current);
    privateState.db.getDb().prepare(
      'UPDATE files SET haskell_topology_hash = NULL WHERE path = ?',
    ).run('Lib.hs');
    const original = privateState.orchestrator.invalidateHaskellImportEdges
      .bind(privateState.orchestrator);
    let broadReplays = 0;
    privateState.orchestrator.invalidateHaskellImportEdges = (...args: unknown[]) => {
      broadReplays++;
      return original(...args);
    };

    fs.writeFileSync(path.join(tmpDir!, 'Lib.hs'), [
      'module Lib (foo) where',
      '-- first post-migration edit',
      'foo x = x',
      '',
    ].join('\n'));
    await current.sync();

    expect(broadReplays).toBe(1);
    expect(privateState.queries.getFileByPath('Lib.hs')!.haskellTopologyHash).toBeTruthy();
    expect(callTarget(current)!.filePath).toBe('Lib.hs');
  });
});

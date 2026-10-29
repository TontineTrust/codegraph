import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

describe('Haskell constructor membership during sync', () => {
  const projects: Array<{ graph: CodeGraph; directory: string }> = [];
  const origins = [
    'module Origin where\ndata R = A { helper :: Int -> Int } | B { other :: Int }\n',
    'module Origin where\ndata R = A { helper :: Int -> Int } | B { helper :: Int -> Int, other :: Int }\n',
  ];
  const consumer = [
    '{-# LANGUAGE RecordWildCards #-}',
    'module Sample where',
    'import qualified Origin as O',
    'helper x = x',
    'run O.B{..} = helper 1',
    'stored O.B{..} = [helper]',
    'control = helper 1',
  ].join('\n');

  afterEach(() => {
    for (const { graph, directory } of projects) {
      graph.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
    projects.length = 0;
  });

  async function create(origin: string) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-record-topology-'));
    fs.writeFileSync(path.join(directory, 'Origin.hs'), origin);
    fs.writeFileSync(path.join(directory, 'Sample.hs'), consumer);
    const graph = CodeGraph.initSync(directory);
    const project = { graph, directory };
    projects.push(project);
    expect((await graph.indexAll()).success).toBe(true);
    return project;
  }

  function snapshot(graph: CodeGraph) {
    return Object.fromEntries(['run', 'stored', 'control'].map((name) => {
      const owner = graph.getNodesByName(name)[0]!;
      const dependencies = graph.getOutgoingEdges(owner.id).flatMap((edge) => {
        const target = graph.getNode(edge.target)!;
        return target.name === 'helper' ? [{ kind: edge.kind, target: target.qualifiedName }] : [];
      });
      return [name, dependencies];
    }));
  }

  it.each([[0, 1], [1, 0]])('replays calls and stored values when shared fields change from %s to %s', async (before, after) => {
    const { graph, directory } = await create(origins[before]!);
    fs.writeFileSync(path.join(directory, 'Origin.hs'), origins[after]!);
    await graph.sync();
    const fresh = await create(origins[after]!);
    const expected = {
      run: after === 1 ? [] : [{ kind: 'calls', target: 'Sample::helper' }],
      stored: after === 1 ? [] : [{ kind: 'references', target: 'Sample::helper' }],
      control: [{ kind: 'calls', target: 'Sample::helper' }],
    };
    expect(snapshot(fresh.graph)).toEqual(expected);
    expect(snapshot(graph)).toEqual(expected);
  });
});

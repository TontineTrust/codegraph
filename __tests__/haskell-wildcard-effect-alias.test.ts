import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

describe('Haskell wildcard evidence and whole-RHS effects', () => {
  const projects: Array<{ graph: CodeGraph; directory: string }> = [];
  afterEach(() => {
    for (const { graph, directory } of projects) {
      graph.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
    projects.length = 0;
  });

  async function create(files: Record<string, string>) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-wildcard-effect-'));
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), source);
    const graph = CodeGraph.initSync(directory);
    const project = { graph, directory };
    projects.push(project);
    expect((await graph.indexAll()).success).toBe(true);
    return project;
  }

  function actionEdges(graph: CodeGraph, name: string) {
    const owner = graph.getNodesByName(name).find((node) => node.filePath === 'Sample.hs')!;
    return graph.getOutgoingEdges(owner.id).flatMap((edge) => {
      const target = graph.getNode(edge.target)!;
      return target.name === 'action' ? [{ kind: edge.kind, target: target.qualifiedName }] : [];
    });
  }

  it.each([true, false])('preserves effect provenance with canonical IO=%s', async (canonical) => {
    const { graph } = await create({ 'Sample.hs': [
      '{-# LANGUAGE RecordWildCards #-}',
      'module Sample where',
      ...(canonical ? [] : ['import Prelude hiding (IO)', 'data IO a = Custom a']),
      'data R = R { other :: Int }',
      'action :: IO ()',
      canonical ? 'action = pure ()' : 'action = Custom ()',
      'run :: R -> IO ()',
      'run R{..} = action',
      'control :: R -> IO ()',
      'control R{} = action',
    ].join('\n') });
    const expected = [{ kind: canonical ? 'calls' : 'references', target: 'Sample::action' }];
    expect(actionEdges(graph, 'control')).toEqual(expected);
    expect(actionEdges(graph, 'run')).toEqual(expected);
  });

  it('replays action capture without losing the canonical effect evidence', async () => {
    const files = {
      'Origin.hs': 'module Origin where\ndata R = R { other :: Int }\n',
      'Sample.hs': [
        '{-# LANGUAGE RecordWildCards #-}',
        'module Sample where',
        'import qualified Origin as O',
        'action :: IO ()',
        'action = pure ()',
        'run :: O.R -> IO ()',
        'run O.R{..} = action',
      ].join('\n'),
    };
    const { graph, directory } = await create(files);
    expect(actionEdges(graph, 'run')).toEqual([{ kind: 'calls', target: 'Sample::action' }]);
    for (const [source, captured] of [
      ['module Origin where\ndata R = R { action :: IO () }\n', true],
      ['module Origin where\ndata R = R { other :: Int }\n', false],
    ] as const) {
      files['Origin.hs'] = source;
      fs.writeFileSync(path.join(directory, 'Origin.hs'), source);
      await graph.sync();
      const fresh = await create(files);
      const expected = captured ? [] : [{ kind: 'calls', target: 'Sample::action' }];
      expect(actionEdges(fresh.graph, 'run')).toEqual(expected);
      expect(actionEdges(graph, 'run')).toEqual(expected);
    }
  });
});

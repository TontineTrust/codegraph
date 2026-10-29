import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

describe('Haskell qualified operator dependencies', () => {
  const projects: Array<{ graph: CodeGraph; dir: string }> = [];

  afterEach(() => {
    for (const { graph, dir } of projects) {
      graph.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    projects.length = 0;
  });

  async function index(source: string, extra: Record<string, string> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-qualified-operator-'));
    for (const [file, content] of Object.entries({ 'Sample.hs': source, ...extra })) {
      fs.writeFileSync(path.join(dir, file), content);
    }
    const graph = CodeGraph.initSync(dir);
    projects.push({ graph, dir });
    const result = await graph.indexAll();
    expect(result.filesErrored).toBe(0);
    return graph;
  }

  function helperEdges(graph: CodeGraph) {
    const run = graph.getNodesByName('run').find((node) => node.filePath === 'Sample.hs')!;
    return graph.getOutgoingEdges(run.id)
      .filter((edge) => graph.getNode(edge.target)?.name === 'helper')
      .map((edge) => edge.kind);
  }

  it.each([
    ['qualified application', 'Prelude', 'helper P.$ x'],
    ['qualified strict application', 'Prelude', 'helper P.$! x'],
    ['qualified reverse application', 'Data.Function', 'x P.& helper'],
    ['prefix application', 'Prelude', '($) helper x'],
    ['qualified prefix application', 'Prelude', '(P.$) helper x'],
    ['qualified prefix strict application', 'Prelude', '(P.$!) helper x'],
    ['qualified prefix reverse application', 'Data.Function', '(P.&) x helper'],
  ])('records execution through %s', async (_label, moduleName, expression) => {
    const graph = await index(`module Sample where
import Prelude
import qualified ${moduleName} as P
helper x = x
run x = ${expression}
`);
    // Prefix syntax also passes the helper as a value; its reference edge is
    // retained independently of the proven execution edge.
    expect(helperEdges(graph).filter((kind) => kind === 'calls')).toEqual(['calls']);
  });

  it.each([
    ['composition', 'Prelude', 'helper P.. id', 'helper x = x'],
    ['bind continuation', 'Prelude', 'Just 1 P.>>= helper', 'helper x = Just x'],
    ['reverse bind continuation', 'Prelude', 'helper P.=<< Just 1', 'helper x = Just x'],
    ['fmap function', 'Prelude', 'helper P.<$> Just 1', 'helper x = x'],
    ['flipped fmap function', 'Data.Functor', 'Just 1 P.<&> helper', 'helper x = x'],
  ])('keeps qualified %s operands as function references', async (_label, moduleName, expression, helper) => {
    const graph = await index(`module Sample where
import Prelude
import qualified ${moduleName} as P
${helper}
run = ${expression}
`);
    expect(helperEdges(graph)).toEqual(['references']);
  });

  it('retains custom qualified application operands without inventing execution', async () => {
    const graph = await index(`module Sample where
import qualified Custom as C
helper x = x
run x = helper C.$ x
`, { 'Custom.hs': 'module Custom (($)) where\n($) _ x = x\n' });
    expect(helperEdges(graph)).toEqual(['references']);
  });

  it('keeps a partially applied application operator as a value dependency', async () => {
    const graph = await index(`module Sample where
import qualified Prelude as P
helper x = x
run = (P.$) helper
`);
    expect(helperEdges(graph)).toEqual(['references']);
  });

  it.each([
    'helper @Int P.$ x',
    '(P.$) (helper @Int) x',
  ])('recognizes a specialized function applied by %s', async (expression) => {
    const graph = await index(`{-# LANGUAGE TypeApplications #-}
module Sample where
import Prelude
import qualified Prelude as P
helper :: a -> a
helper x = x
run x = ${expression}
`);
    expect(helperEdges(graph).filter((kind) => kind === 'calls')).toEqual(['calls']);
  });
});

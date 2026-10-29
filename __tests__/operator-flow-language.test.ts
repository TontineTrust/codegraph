import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { findAllSymbols, resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';

describe('operator flows across language-specific spellings', () => {
  let graph: CodeGraph | undefined;
  let directory: string | undefined;

  afterEach(() => {
    graph?.destroy();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([false, true])('finds bare Scala operator endpoints with Haskell present=%s', async (withHaskell) => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-operator-flow-language-'));
    fs.writeFileSync(path.join(directory, 'Ops.scala'), `object Ops {
  def finishScala(x: Int): Int = x
  def +(x: Int): Int = finishScala(x)
}`);
    if (withHaskell) {
      fs.writeFileSync(path.join(directory, 'HsOps.hs'), `module HsOps ((+), finishHaskell) where
import Prelude hiding ((+))
(+) x _ = finishHaskell x
finishHaskell x = x
`);
    }
    graph = CodeGraph.initSync(directory);
    expect((await graph.indexAll()).success).toBe(true);

    for (const from of ['+', '(+)', 'Ops.+']) {
      const flow = resolveNamedSymbolFlow(graph, '', { mode: 'directed', from, to: 'finishScala' });
      expect(flow.chains.map((chain) => chain.steps.map((step) => step.node.name)), from)
        .toContainEqual(['+', 'finishScala']);
    }
    const flow = resolveNamedSymbolFlow(graph, '(+) finishScala');
    expect(flow.chains.map((chain) => chain.steps.map((step) => step.node.name)))
      .toContainEqual(['+', 'finishScala']);
    expect(findAllSymbols(graph, '(*)').nodes).toEqual([]);

    if (withHaskell) {
      const haskellFlow = resolveNamedSymbolFlow(graph, '', {
        mode: 'directed', from: '+', to: 'finishHaskell',
      });
      expect(haskellFlow.chains.map((chain) => chain.steps.map((step) => step.node.name)))
        .toContainEqual(['(+)', 'finishHaskell']);
    }
  });
});

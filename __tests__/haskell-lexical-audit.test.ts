import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['haskell']);
});

describe('Haskell lexical scope audit', () => {
  let dir: string | undefined;
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    graph = undefined;
    dir = undefined;
  });

  async function helperCalls(source: string) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-lexical-audit-'));
    fs.writeFileSync(path.join(dir, 'Library.hs'), 'module Library where\nhelper x = x\n');
    fs.writeFileSync(path.join(dir, 'Audit.hs'), source);
    graph = CodeGraph.initSync(dir);
    const result = await graph.indexAll();
    expect(result.errors).toEqual([]);
    const owner = graph.getNodesByName('run').find((node) => node.filePath === 'Audit.hs')!;
    return graph.getOutgoingEdges(owner.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => ({ edge, node: graph!.getNode(edge.target)! }))
      .filter(({ node }) => node.name === 'helper')
      .sort((a, b) => a.edge.line! - b.edge.line! || a.edge.column! - b.edge.column!)
      .map(({ edge, node }) => [edge.line, node.filePath, node.startLine]);
  }

  it('keeps a guard let out of earlier guards and sibling guarded RHSs', async () => {
    expect(await helperCalls(`module Audit where
import Library (helper)
run value
  | helper value
  , let helper x = x
  , helper value = helper value
  | otherwise = helper value
`)).toEqual([
      [4, 'Library.hs', 2],
      [6, 'Audit.hs', 5],
      [6, 'Audit.hs', 5],
      [7, 'Library.hs', 2],
    ]);
  });

  it('scopes comprehension functions over the output and following qualifiers', async () => {
    expect(await helperCalls(`module Audit where
import Library (helper)
run values =
  [ helper value
  | helper True
  , value <- values
  , let helper x = x
  , helper value
  ]
`)).toEqual([
      [4, 'Audit.hs', 7],
      [5, 'Library.hs', 2],
      [8, 'Audit.hs', 7],
    ]);
  });

  it('uses the last comprehension let in the output without changing earlier qualifiers', async () => {
    expect(await helperCalls(`module Audit where
import Library (helper)
run values =
  [ helper value
  | value <- values
  , let helper x = x
  , helper value
  , let helper x = not x
  , helper value
  ]
`)).toEqual([
      [4, 'Audit.hs', 8],
      [7, 'Audit.hs', 6],
      [9, 'Audit.hs', 8],
    ]);
  });

  it('prefers an inner comprehension function over an outer output-visible binding', async () => {
    expect(await helperCalls(`module Audit where
import Library (helper)
run values =
  [ [ helper value
    | value <- inner
    , let helper x = x
    ]
  | inner <- values
  , let helper x = not x
  , helper True
  ]
`)).toEqual([
      [4, 'Audit.hs', 6],
      [10, 'Audit.hs', 9],
    ]);
  });

  it.each([
    ['function', `{-# LANGUAGE ViewPatterns #-}
module Audit where
import Library (helper)
run (helper -> Just item) = helper item
  where helper x = x
`, [[4, 'Library.hs', 2], [4, 'Audit.hs', 5]]],
    ['case alternative', `{-# LANGUAGE ViewPatterns #-}
module Audit where
import Library (helper)
run value = case value of
  (helper -> Just item) -> helper item
    where helper x = x
  Nothing -> helper True
`, [[5, 'Library.hs', 2], [5, 'Audit.hs', 6], [7, 'Library.hs', 2]]],
  ])('keeps a %s where function out of its LHS view pattern', async (_label, source, expected) => {
    expect(await helperCalls(source as string)).toEqual(expected);
  });

  it('keeps a value-binding where function inside that binding', async () => {
    expect(await helperCalls(`module Audit where
import Library (helper)
run value =
  let answer = helper value
        where helper x = x
  in (answer, helper value)
`)).toEqual([
      [4, 'Audit.hs', 5],
      [6, 'Library.hs', 2],
    ]);
  });
});

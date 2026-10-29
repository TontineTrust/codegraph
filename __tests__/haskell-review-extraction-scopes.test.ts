import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['haskell']);
});

describe('Haskell review: lexical scopes and stored function values', () => {
  const projects: Array<{ graph: CodeGraph; directory: string }> = [];

  afterEach(() => {
    for (const { graph, directory } of projects) {
      graph.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
    projects.length = 0;
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-review-scopes-'));
    for (const [file, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(directory, file), source);
    }
    const graph = CodeGraph.initSync(directory);
    projects.push({ graph, directory });
    await graph.indexAll();
    return graph;
  }

  function helperCalls(graph: CodeGraph, owner: string) {
    const node = graph.getNodesByName(owner).find((candidate) => candidate.filePath === 'Sample.hs')!;
    return graph.getOutgoingEdges(node.id)
      .filter((edge) => edge.kind === 'calls' && graph.getNode(edge.target)?.name === 'helper')
      .map((edge) => ({ line: edge.line, column: edge.column, targetLine: graph.getNode(edge.target)!.startLine }))
      .sort((a, b) => (a.line! - b.line!) || (a.column! - b.column!));
  }

  it('keeps a guard let out of preceding guards and separate guarded right-hand sides', async () => {
    const graph = await index({ 'Sample.hs': [
      'module Sample where',
      'helper x = True',
      'run x | helper x, let helper y = False = helper x',
      '      | otherwise = helper x',
    ].join('\n') });

    expect(helperCalls(graph, 'run')).toEqual([
      { line: 3, column: 8, targetLine: 2 },
      { line: 3, column: 41, targetLine: 3 },
      { line: 4, column: 20, targetLine: 2 },
    ]);
  });

  it('uses sequential comprehension scopes and the last visible helper in the output', async () => {
    const graph = await index({ 'Sample.hs': [
      'module Sample where',
      'helper x = True',
      'run xs = [helper x',
      '         | x <- xs',
      '         , helper x',
      '         , let helper y = y',
      '         , helper x',
      '         , let helper y = not y',
      '         , helper x]',
    ].join('\n') });

    expect(helperCalls(graph, 'run')).toEqual([
      { line: 3, column: 10, targetLine: 8 },
      { line: 5, column: 11, targetLine: 2 },
      { line: 7, column: 11, targetLine: 6 },
      { line: 9, column: 11, targetLine: 8 },
    ]);
  });

  it('lets a nested expression scope shadow a comprehension helper only inside that expression', async () => {
    const graph = await index({ 'Sample.hs': [
      'module Sample where',
      'helper x = True',
      'run xs = [(let helper y = False in helper x, helper x)',
      '         | x <- xs',
      '         , let helper y = y]',
    ].join('\n') });

    expect(helperCalls(graph, 'run')).toEqual([
      { line: 3, column: 35, targetLine: 3 },
      { line: 3, column: 45, targetLine: 5 },
    ]);
  });

  it('suppresses outer homonyms shadowed by a case-alternative where value', async () => {
    const graph = await index({ 'Sample.hs': [
      'module Sample where',
      'helper x = x',
      'run x = case x of',
      '  Just y -> helper y',
      '    where helper = id',
      '  Nothing -> helper 0',
    ].join('\n') });

    expect(helperCalls(graph, 'run')).toEqual([
      { line: 6, column: 13, targetLine: 2 },
    ]);
  });

  it('resolves an alternative where function that shadows a pattern binder', async () => {
    const graph = await index({ 'Sample.hs': [
      'module Sample where',
      'run x = case x of',
      '  helper -> helper x',
      '    where helper y = y',
    ].join('\n') });

    expect(helperCalls(graph, 'run')).toEqual([
      { line: 3, column: 12, targetLine: 4 },
    ]);
  });

  it('keeps an alternative where value out of its view-pattern expression', async () => {
    const graph = await index({ 'Sample.hs': [
      '{-# LANGUAGE ViewPatterns #-}',
      'module Sample where',
      'helper x = x',
      'run x = case x of',
      '  (helper -> y) -> helper y',
      '    where helper = id',
    ].join('\n') });

    expect(helperCalls(graph, 'run')).toEqual([
      { line: 5, column: 3, targetLine: 3 },
    ]);
  });

  it('keeps an alternative where function out of its view-pattern expression', async () => {
    const graph = await index({ 'Sample.hs': [
      '{-# LANGUAGE ViewPatterns #-}',
      'module Sample where',
      'helper x = x',
      'run x = case x of',
      '  (helper -> y) -> helper y',
      '    where helper value = value',
    ].join('\n') });

    expect(helperCalls(graph, 'run')).toEqual([
      { line: 5, column: 3, targetLine: 3 },
      { line: 5, column: 19, targetLine: 6 },
    ]);
  });

  it('keeps a function where helper out of its left-hand-side view pattern', async () => {
    const graph = await index({ 'Sample.hs': [
      '{-# LANGUAGE ViewPatterns #-}',
      'module Sample where',
      'helper x = x',
      'run (helper -> y) = helper y',
      '  where helper value = value',
    ].join('\n') });

    expect(helperCalls(graph, 'run')).toEqual([
      { line: 4, column: 5, targetLine: 3 },
      { line: 4, column: 20, targetLine: 5 },
    ]);
  });

  it('retains qualified and prefix-operator values stored in data positions', async () => {
    const graph = await index({
      'A.hs': 'module A where\nhelper x = x\n(<+>) x y = x + y\n',
      'Sample.hs': [
        'module Sample where',
        'import qualified A',
        'import A ((<+>))',
        'data R = R { callback :: Int -> Int }',
        'list = [A.helper]',
        'tuple = (A.helper, A.helper)',
        'record = R { callback = (A.helper) }',
        'operators = [(A.<+>), (<+>)]',
      ].join('\n'),
    });

    for (const [owner, target, count] of [
      ['list', 'helper', 1], ['tuple', 'helper', 2],
      ['record', 'helper', 1], ['operators', '(<+>)', 2],
    ] as const) {
      const node = graph.getNodesByName(owner).find((candidate) => candidate.filePath === 'Sample.hs')!;
      const edges = graph.getOutgoingEdges(node.id)
        .filter((edge) => graph.getNode(edge.target)?.name === target);
      expect(edges, owner).toHaveLength(count);
      expect(edges.every((edge) => edge.kind === 'references' && graph.getNode(edge.target)?.filePath === 'A.hs')).toBe(true);
    }
  });

  it('does not invent qualified targets from unimported or hidden homonyms', async () => {
    const graph = await index({
      'A.hs': 'module A where\nhelper x = x\n',
      'Sample.hs': [
        'module Sample where',
        'import qualified A as Imported hiding (helper)',
        'helper x = x',
        'hidden = [Imported.helper]',
        'unimported = [A.helper]',
      ].join('\n'),
    });

    for (const owner of ['hidden', 'unimported']) {
      const node = graph.getNodesByName(owner).find((candidate) => candidate.filePath === 'Sample.hs')!;
      expect(graph.getOutgoingEdges(node.id)
        .filter((edge) => graph.getNode(edge.target)?.name === 'helper')).toEqual([]);
    }
  });
});

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

describe('Haskell review: binding evidence', () => {
  const projects: Array<{ graph: CodeGraph; directory: string }> = [];
  afterEach(() => {
    for (const { graph, directory } of projects) {
      graph.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
    projects.length = 0;
  });

  async function index(files: Record<string, string>) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-binding-evidence-'));
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), source);
    const graph = CodeGraph.initSync(directory);
    const project = { graph, directory };
    projects.push(project);
    await graph.indexAll();
    return project;
  }

  function targets(graph: CodeGraph, owner: string, targetName: string) {
    const node = graph.getNodesByName(owner).find((candidate) => candidate.filePath === 'Sample.hs')!;
    return graph.getOutgoingEdges(node.id).flatMap((edge) => {
      const target = graph.getNode(edge.target)!;
      return target.name === targetName && edge.kind !== 'contains'
        ? [{ kind: edge.kind, line: edge.line, target: target.qualifiedName, targetLine: target.startLine }]
        : [];
    }).sort((a, b) => (a.line! - b.line!) || a.target.localeCompare(b.target));
  }

  it('bounds a local value where group to that binding', async () => {
    const { graph } = await index({ 'Sample.hs': [
      'module Sample where',
      'helper x = x + 1',
      'run x = let result = helper x where helper y = y + 2',
      '        in (result, helper x)',
      'nested x = (value, helper x)',
      '  where value = helper x',
      '          where helper y = y + 2',
    ].join('\n') });
    expect(targets(graph, 'run', 'helper')).toEqual([
      { kind: 'calls', line: 3, target: 'Sample::run::helper', targetLine: 3 },
      { kind: 'calls', line: 4, target: 'Sample::helper', targetLine: 2 },
    ]);
    expect(targets(graph, 'nested', 'helper')).toEqual([
      { kind: 'calls', line: 5, target: 'Sample::helper', targetLine: 2 },
      { kind: 'calls', line: 6, target: 'Sample::nested::helper', targetLine: 7 },
    ]);
  });

  it('treats wildcard fields as binders without hiding explicit or sibling-constructor fields', async () => {
    const { graph } = await index({ 'Sample.hs': [
      '{-# LANGUAGE RecordWildCards, NamedFieldPuns #-}',
      'module Sample where',
      'data R = R { helper :: Int -> Int } | Other { other :: Int }',
      'run R{..} x = helper x',
      'pun R{helper} x = helper x',
      'explicit R{helper = callback,..} r x = helper r (callback x)',
      'sibling Other{..} r x = helper r x + other',
      'qualified R{..} r x = Sample.helper r x',
      'nested R{..} x = let helper y = y + 1 in helper x',
    ].join('\n') });
    expect(targets(graph, 'run', 'helper')).toEqual([]);
    expect(targets(graph, 'pun', 'helper')).toEqual([]);
    for (const owner of ['explicit', 'sibling', 'qualified']) {
      expect(targets(graph, owner, 'helper')).toEqual([
        expect.objectContaining({ kind: 'calls', target: 'Sample::R::helper' }),
      ]);
    }
    expect(targets(graph, 'nested', 'helper')).toEqual([
      expect.objectContaining({ kind: 'calls', target: 'Sample::nested::helper' }),
    ]);
  });

  it('respects sequential wildcard patterns in do and comprehension scopes', async () => {
    const { graph } = await index({ 'Sample.hs': [
      '{-# LANGUAGE RecordWildCards #-}',
      'module Sample where',
      'data R = R { helper :: Int -> Int }',
      'run records = do',
      '  let before r = helper r 1',
      '  R{..} <- records',
      '  pure (before, helper 2)',
      'list records = [helper 2 | r <- records, helper r 1 > 0, R{..} <- [r]]',
    ].join('\n') });
    expect(targets(graph, 'run', 'helper')).toEqual([]);
    expect(targets(graph, 'before', 'helper')).toEqual([
      expect.objectContaining({ kind: 'calls', line: 5, target: 'Sample::R::helper' }),
    ]);
    expect(targets(graph, 'list', 'helper')).toEqual([
      expect.objectContaining({ kind: 'calls', line: 8, target: 'Sample::R::helper' }),
    ]);
  });

  it('suppresses wildcard-bound fields from qualified imports and NoFieldSelectors records', async () => {
    const { graph } = await index({
      'Origin.hs': '{-# LANGUAGE NoFieldSelectors #-}\nmodule Origin where\ndata R = R { helper :: Int -> Int }\n',
      'Sample.hs': [
        '{-# LANGUAGE RecordWildCards #-}',
        'module Sample where',
        'import qualified Origin as O',
        'helper x = x + 1',
        'run O.R{..} x = helper x',
      ].join('\n'),
    });
    expect(targets(graph, 'run', 'helper')).toEqual([]);
  });

  it('rechecks imported wildcard visibility and renamed fields during incremental sync', async () => {
    const files = {
      'Origin.hs': 'module Origin where\ndata R = R { helper :: Int -> Int }\n',
      'Facade.hs': 'module Facade (R(R)) where\nimport Origin\n',
      'Sample.hs': 'module Sample where\nimport qualified Facade as F\nhelper x = x + 1\nrun F.R{..} x = helper x\n',
    };
    files['Sample.hs'] = '{-# LANGUAGE RecordWildCards #-}\n' + files['Sample.hs'];
    const { graph, directory } = await index(files);
    const snapshot = (current: CodeGraph) => targets(current, 'run', 'helper');
    expect(snapshot(graph)).toEqual([
      expect.objectContaining({ kind: 'calls', target: 'Sample::helper' }),
    ]);
    for (const [file, source, count] of [
      ['Facade.hs', 'module Facade (R(..)) where\nimport Origin\n', 0],
      ['Origin.hs', 'module Origin where\ndata R = R { renamed :: Int -> Int }\n', 1],
      ['Origin.hs', 'module Origin where\ndata R = R { helper :: Int -> Int }\n', 0],
      ['Facade.hs', 'module Facade (R(R)) where\nimport Origin\n', 1],
    ] as const) {
      files[file] = source;
      fs.writeFileSync(path.join(directory, file), source);
      await graph.sync();
      expect(snapshot(graph)).toHaveLength(count);
      const fresh = await index(files);
      expect(snapshot(graph)).toEqual(snapshot(fresh.graph));
    }
  });

  it('does not reuse an outer parameter annotation after receiver shadowing', async () => {
    const { graph } = await index({ 'Sample.hs': [
      '{-# LANGUAGE DuplicateRecordFields, OverloadedRecordDot #-}',
      'module Sample where',
      'data A = A { value :: Int }',
      'data B = B { value :: Bool }',
      'lambda :: A -> Bool',
      'lambda item = (\\item -> item.value) (B True)',
      'local :: A -> Bool',
      'local item = let item = B True in item.value',
      'caseShadow :: A -> Bool',
      'caseShadow item = case B True of item -> item.value',
      'unshadowed :: A -> Int',
      'unshadowed item = (\\other -> item.value) ()',
    ].join('\n') });
    for (const owner of ['lambda', 'local', 'caseShadow']) expect(targets(graph, owner, 'value')).toEqual([]);
    expect(targets(graph, 'unshadowed', 'value')).toEqual([
      expect.objectContaining({ kind: 'references', target: 'Sample::A::value' }),
    ]);
  });

  it('replays local function calls and values when an imported wildcard gains their name', async () => {
    const files = {
      'Origin.hs': 'module Origin where\ndata R = R { other :: Int }\n',
      'Sample.hs': [
        '{-# LANGUAGE RecordWildCards #-}',
        'module Sample where',
        'import qualified Origin as O',
        'run record = let helper x = x in case record of O.R{..} -> helper 1',
        'stored record = let helper x = x in case record of O.R{..} -> [helper]',
      ].join('\n'),
    };
    const { graph, directory } = await index(files);
    for (const owner of ['run', 'stored']) expect(targets(graph, owner, 'helper')).toHaveLength(1);
    for (const [source, count] of [
      ['module Origin where\ndata R = R { helper :: Int -> Int }\n', 0],
      ['module Origin where\ndata R = R { other :: Int }\n', 1],
    ] as const) {
      files['Origin.hs'] = source;
      fs.writeFileSync(path.join(directory, 'Origin.hs'), source);
      await graph.sync();
      const fresh = await index(files);
      for (const owner of ['run', 'stored']) {
        expect(targets(graph, owner, 'helper')).toHaveLength(count);
        expect(targets(graph, owner, 'helper')).toEqual(targets(fresh.graph, owner, 'helper'));
      }
    }
  });

  it('retains projection shadow evidence while imported field visibility changes', async () => {
    const files = {
      'Types.hs': 'module Types (A(..)) where\ndata A = A { value :: Int }\n',
      'Sample.hs': [
        '{-# LANGUAGE DuplicateRecordFields, OverloadedRecordDot #-}',
        'module Sample where',
        'import Types',
        'data B = B { value :: Bool }',
        'shadowed :: A -> Bool',
        'shadowed item = (\\item -> item.value) (B True)',
        'unshadowed :: A -> Int',
        'unshadowed item = item.value',
      ].join('\n'),
    };
    const { graph, directory } = await index(files);
    expect(targets(graph, 'shadowed', 'value')).toEqual([]);
    expect(targets(graph, 'unshadowed', 'value')).toHaveLength(1);
    for (const [source, count] of [
      ['module Types (A(A)) where\ndata A = A { value :: Int }\n', 0],
      ['module Types (A(..)) where\ndata A = A { value :: Int }\n', 1],
    ] as const) {
      files['Types.hs'] = source;
      fs.writeFileSync(path.join(directory, 'Types.hs'), source);
      await graph.sync();
      const fresh = await index(files);
      expect(targets(graph, 'shadowed', 'value')).toEqual([]);
      expect(targets(graph, 'unshadowed', 'value')).toHaveLength(count);
      for (const owner of ['shadowed', 'unshadowed']) {
        expect(targets(graph, owner, 'value')).toEqual(targets(fresh.graph, owner, 'value'));
      }
    }
  });

  it('uses a later wildcard binder instead of an earlier helper in sequential scopes', async () => {
    const { graph } = await index({ 'Sample.hs': [
      '{-# LANGUAGE RecordWildCards #-}',
      'module Sample where',
      'data R = R { helper :: Int -> Int }',
      'run records = do',
      '  let helper x = x + 1',
      '  R{..} <- records',
      '  pure (helper 1)',
      'control records = do',
      '  R{..} <- records',
      '  let helper x = x + 1',
      '  pure (helper 1)',
      'list records = [helper 1 | let helper x = x + 1, R{..} <- records]',
      'listControl records = [helper 1 | R{..} <- records, let helper x = x + 1]',
      'guarded record | let helper x = x + 1, R{..} <- record = helper 1',
      'guardControl record | R{..} <- record, let helper x = x + 1 = helper 1',
    ].join('\n') });
    for (const owner of ['run', 'list', 'guarded']) expect(targets(graph, owner, 'helper')).toEqual([]);
    for (const owner of ['control', 'listControl', 'guardControl']) {
      expect(targets(graph, owner, 'helper')).toEqual([
        expect.objectContaining({ kind: 'calls', target: `Sample::${owner}::helper` }),
      ]);
    }
  });

  it('keeps wildcard binders recursive in mdo and explicit rec groups', async () => {
    const { graph } = await index({ 'Sample.hs': [
      '{-# LANGUAGE RecordWildCards, RecursiveDo #-}',
      'module Sample where',
      'data R = R { helper :: Int -> Int }',
      'recursive records = mdo',
      '  let result = helper 1',
      '  R{..} <- records',
      '  pure result',
      'explicit records = do',
      '  rec',
      '    let result = helper 1',
      '    R{..} <- records',
      '  pure result',
    ].join('\n') });
    expect(targets(graph, 'recursive', 'helper')).toEqual([]);
    expect(targets(graph, 'explicit', 'helper')).toEqual([]);
  });

  it('does not apply an outer annotation to a wildcard-bound projection receiver', async () => {
    const { graph } = await index({ 'Sample.hs': [
      '{-# LANGUAGE RecordWildCards, DuplicateRecordFields, OverloadedRecordDot #-}',
      'module Sample where',
      'data A = A { value :: Int }',
      'data B = B { value :: Bool }',
      'data Box = Box { item :: B }',
      'shadowed :: A -> Bool',
      'shadowed item = case Box (B True) of Box{..} -> item.value',
      'unshadowed :: A -> Int',
      'unshadowed item = case Box (B True) of Box{item = inner} -> item.value',
    ].join('\n') });
    expect(targets(graph, 'shadowed', 'value')).toEqual([]);
    expect(targets(graph, 'unshadowed', 'value')).toEqual([
      expect.objectContaining({ kind: 'references', target: 'Sample::A::value' }),
    ]);
  });

  it('rechecks imported wildcard receiver capture when field visibility changes', async () => {
    const files = {
      'Origin.hs': 'module Origin (Box(Box), B(value)) where\ndata B = B { value :: Bool }\ndata Box = Box { item :: B }\n',
      'Sample.hs': [
        '{-# LANGUAGE RecordWildCards, OverloadedRecordDot #-}',
        'module Sample where',
        'import qualified Origin as O',
        'data A = A { value :: Int }',
        'run :: A -> O.Box -> ()',
        'run item box = case box of O.Box{..} -> const () item.value',
        'control :: A -> O.Box -> ()',
        'control item box = case box of O.Box{} -> const () item.value',
      ].join('\n'),
    };
    const { graph, directory } = await index(files);
    expect(targets(graph, 'run', 'value')).toHaveLength(1);
    for (const [source, count] of [
      ['module Origin (Box(..), B(value)) where\ndata B = B { value :: Bool }\ndata Box = Box { item :: B }\n', 0],
      ['module Origin (Box(Box), B(value)) where\ndata B = B { value :: Bool }\ndata Box = Box { item :: B }\n', 1],
    ] as const) {
      files['Origin.hs'] = source;
      fs.writeFileSync(path.join(directory, 'Origin.hs'), source);
      await graph.sync();
      const fresh = await index(files);
      expect(targets(graph, 'run', 'value')).toHaveLength(count);
      expect(targets(graph, 'run', 'value')).toEqual(targets(fresh.graph, 'run', 'value'));
      expect(targets(graph, 'control', 'value')).toEqual([
        expect.objectContaining({ kind: 'references', target: 'Sample::A::value' }),
      ]);
    }
  });
});

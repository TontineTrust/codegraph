import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { extractImportMappings } from '../src/resolution/import-resolver';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Haskell support', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('detects modules and extracts grouped equations, signatures, data, and calls', () => {
    const source = `
module Example.Domain where

import Data.Text qualified as Text

data Mode = Fast | Slow

format :: Mode -> String
format Fast = Text.unpack "fast"
format Slow = helper "slow"

helper value = value

pointFree :: Mode -> String
pointFree = format

label :: String
label = "mode"

applyDollar value = helper $ value

outer value =
  let local item = helper item
   in local value
`;
    const result = extractFromSource('src/Example/Domain.hs', source);

    expect(detectLanguage('src/Example/Domain.hs')).toBe('haskell');
    expect(result.nodes.some((node) => node.kind === 'namespace' && node.name === 'Example.Domain')).toBe(true);
    expect(result.nodes.filter((node) => node.kind === 'function' && node.name === 'format')).toHaveLength(1);
    expect(result.nodes.find((node) => node.kind === 'function' && node.name === 'format')?.signature)
      .toBe('format :: Mode -> String');
    expect(result.nodes.some((node) => node.kind === 'enum' && node.name === 'Mode')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'Fast')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'Slow')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'pointFree')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'constant' && node.name === 'label')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'local'
      && node.isExported === false)).toBe(true);

    const calls = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(calls).toContain('Text::unpack');
    expect(calls).toContain('helper');
    expect(calls.filter((name) => name === '$')).toHaveLength(0);
  });

  it('extracts point-free instance methods and associated type families', () => {
    const source = `
module Example.Instances where

class Runner a where
  type Result a
  run :: a -> Result a

instance Runner Int where
  type Result Int = String
  run :: Int -> String
  run = show
`;
    const result = extractFromSource('src/Example/Instances.hs', source);

    expect(result.nodes.some((node) => node.kind === 'trait' && node.name === 'Runner')).toBe(true);
    expect(result.nodes.filter((node) => node.kind === 'method' && node.name === 'run')).toHaveLength(2);
    expect(result.nodes.some((node) => node.kind === 'method' && node.name === 'run'
      && node.qualifiedName.includes('Runner Int') && node.startLine === 10 && node.endLine === 11)).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'type_alias' && node.name === 'Result')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'type_alias' && node.name === 'Result Int')).toBe(true);
  });

  it('extracts associated data instances and standalone deriving instances', () => {
    const source = `
{-# LANGUAGE StandaloneDeriving #-}
module Example.DataInstances where

data RowT f = RowT (f Int)

class Table table where
  data PrimaryKey table f

instance Table RowT where
  data PrimaryKey RowT f = RowId (f Int)

deriving instance Show (RowT Maybe)
`;
    const result = extractFromSource('src/Example/DataInstances.hs', source);

    expect(result.nodes.some((node) => node.kind === 'enum' && node.name === 'PrimaryKey'
      && node.qualifiedName.includes('Table RowT'))).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'RowId')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'class' && node.name === 'Show (RowT Maybe)'
      && node.decorators?.includes('haskell-deriving-instance'))).toBe(true);
  });

  it('keeps declarations around a valid nested case expression', () => {
    const source = `
module Example.NestedCase where

extractBankDetails entries =
  let mDetails = do
        entry <- entries
        case lookupObject entry =<< case entry of
          Object value -> Just value
          _ -> Nothing of
          Just details -> Just details
          Nothing -> Nothing
      extract details = details
   in paymentMethodToRail $ extract mDetails
extractBankDetails value = value
`;
    const result = extractFromSource('src/Example/NestedCase.hs', source);

    expect(result.nodes.filter((node) => node.kind === 'function' && node.name === 'extractBankDetails')).toHaveLength(1);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'extract'
      && node.isExported === false)).toBe(true);

    const calls = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(calls).toContain('lookupObject');
    expect(calls).toContain('paymentMethodToRail');
    expect(calls).toContain('extract');
    expect(calls).not.toContain('$');
  });

  it('parses explicit, wildcard, and ImportQualifiedPost imports', () => {
    const mappings = extractImportMappings(
      'Consumer.hs',
      [
        'module Consumer where',
        'import Lib.Api (runThing, Result (..), (>=>))',
        'import Lib.All',
        'import Lib.Sql qualified as SQL',
        'import qualified Lib.Legacy as Legacy',
      ].join('\n'),
      'haskell'
    );

    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'runThing', exportedName: 'runThing', source: 'Lib.Api', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'Result', exportedName: 'Result', source: 'Lib.Api', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: '>=>', exportedName: '>=>', source: 'Lib.Api', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: '*', source: 'Lib.All', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'SQL', source: 'Lib.Sql', isNamespace: true,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'Legacy', source: 'Lib.Legacy', isNamespace: true,
    }));
  });

  it('resolves same-named functions by imported module and captures higher-order uses', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-'));
    fs.mkdirSync(path.join(tmpDir, 'Lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Lib', 'A.hs'), [
      'module Lib.A where',
      'target x = helper x',
      'helper x = x',
      'pointFree :: Int -> Int',
      'pointFree = target',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Lib', 'B.hs'), [
      'module Lib.B where',
      'target x = x',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Lib', 'Facade.hs'), [
      'module Lib.Facade (module Lib.A) where',
      'import Lib.A',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Lib', 'Local.hs'), [
      'module Lib.Local where',
      'outer x = let hidden y = y in hidden x',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Decoy.hs'), [
      'module Decoy where',
      'pure x = x',
      'length _ = 0',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Lib.A (target)',
      'import Lib.A qualified as A',
      'import Lib.B qualified as B',
      'import Lib.Facade (pointFree)',
      'import Lib.Local (hidden)',
      'run xs = do',
      '  mapM_ target xs',
      '  print (A.target 1)',
      '  print (pointFree 1)',
      '  print (B.target 2)',
      '  print (hidden 3)',
      '  pure (length xs)',
    ].join('\n'));

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const targetA = graph.getNodesByName('target').find((node) => node.filePath === 'Lib/A.hs')!;
      const targetB = graph.getNodesByName('target').find((node) => node.filePath === 'Lib/B.hs')!;
      const pointFree = graph.getNodesByName('pointFree').find((node) => node.filePath === 'Lib/A.hs')!;
      const decoyPure = graph.getNodesByName('pure').find((node) => node.filePath === 'Decoy.hs')!;
      const decoyLength = graph.getNodesByName('length').find((node) => node.filePath === 'Decoy.hs')!;
      const localHidden = graph.getNodesByName('hidden').find((node) => node.filePath === 'Lib/Local.hs')!;
      const outgoing = graph.getOutgoingEdges(run.id);

      expect(outgoing.some((edge) => edge.target === targetA.id && edge.kind === 'references')).toBe(true);
      expect(outgoing.some((edge) => edge.target === targetA.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === targetB.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === pointFree.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === decoyPure.id)).toBe(false);
      expect(outgoing.some((edge) => edge.target === decoyLength.id)).toBe(false);
      expect(outgoing.some((edge) => edge.target === localHidden.id)).toBe(false);
    } finally {
      graph.destroy();
    }
  });

  it('preserves the extraction coverage introduced by PR #395', () => {
    const source = `
module Combined where

class (Eq a, Show a) => Render a where
  render :: a -> String

data Person = Person { personName :: String } deriving (Show, Eq)

data Term a where
  IntTerm :: Int -> Term Int

area x = x
total xs = sum (map area xs)

(===) :: Int -> Int -> Bool
x === y = x == y

initialise = pure ()
main = do
  initialise
`;
    const result = extractFromSource('Combined.hs', source);
    const render = result.nodes.find((node) => node.kind === 'trait' && node.name === 'Render')!;
    const person = result.nodes.find((node) => node.kind === 'enum' && node.name === 'Person')!;
    const total = result.nodes.find((node) => node.kind === 'function' && node.name === 'total')!;
    const main = result.nodes.find((node) => node.name === 'main')!;

    expect(result.nodes.some((node) => node.kind === 'field' && node.name === 'personName')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'enum_member' && node.name === 'IntTerm')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === '(===)')).toBe(true);
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === render.id && ref.referenceKind === 'extends')
      .map((ref) => ref.referenceName).sort()).toEqual(['Eq', 'Show']);
    expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === person.id && ref.referenceKind === 'implements')
      .map((ref) => ref.referenceName).sort()).toEqual(['Eq', 'Show']);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === total.id
      && ref.referenceKind === 'calls' && ref.referenceName === 'area')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === main.id
      && ref.referenceKind === 'calls' && ref.referenceName === 'initialise')).toBe(true);
  });

  it('keeps higher-order synthesis function-first and lexical-scope safe', () => {
    const result = extractFromSource('HigherOrder.hs', `
module HigherOrder where
worker x = x
good xs = map worker xs
parameter f xs = map f xs
dataFirst xs f = forM_ xs f
`);
    const callsFrom = (name: string) => {
      const owner = result.nodes.find((node) => node.kind === 'function' && node.name === name)!;
      return result.unresolvedReferences
        .filter((ref) => ref.fromNodeId === owner.id && ref.referenceKind === 'calls')
        .map((ref) => ref.referenceName);
    };
    expect(callsFrom('good')).toContain('worker');
    expect(callsFrom('parameter')).not.toContain('f');
    expect(callsFrom('dataFirst')).not.toContain('xs');
  });

  it('attributes where and operator-body calls to their own grouped symbols', () => {
    const result = extractFromSource('Scopes.hs', `
module Scopes where
helper x = x
describe x = local x where
  local value = helper value
x <+> y = helper x
`);
    const local = result.nodes.find((node) => node.kind === 'function' && node.name === 'local')!;
    const operator = result.nodes.find((node) => node.kind === 'function' && node.name === '(<+>)')!;
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === local.id
      && ref.referenceKind === 'calls' && ref.referenceName === 'helper')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === operator.id
      && ref.referenceKind === 'calls' && ref.referenceName === 'helper')).toBe(true);
  });

  it('captures monadic and composition operators without treating bound parameters as globals', () => {
    const result = extractFromSource('Operators.hs', `
module Operators where
parse x = x
validate x = x
handler x = x
pipeline = parse >=> validate
consume xs = xs >>= handler
parameter f xs = f <$> xs
`);
    const refsFrom = (name: string) => {
      const owner = result.nodes.find((node) => node.name === name)!;
      return result.unresolvedReferences
        .filter((ref) => ref.fromNodeId === owner.id && ref.referenceKind === 'function_ref')
        .map((ref) => ref.referenceName);
    };
    expect(refsFrom('pipeline')).toEqual(expect.arrayContaining(['parse', 'validate']));
    expect(refsFrom('consume')).toContain('handler');
    expect(refsFrom('parameter')).not.toContain('f');
  });

  it('models child imports and hiding restrictions', () => {
    const mappings = extractImportMappings('Consumer.hs', [
      'module Consumer where',
      'import Lib.Api (Result (..), Runner (run), (>=>))',
      'import Lib.Hidden hiding (secret, Box (..))',
    ].join('\n'), 'haskell');

    expect(mappings).toContainEqual(expect.objectContaining({
      localName: '*', source: 'Lib.Api', parentExport: 'Result', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: 'run', source: 'Lib.Api', parentExport: 'Runner', isNamespace: false,
    }));
    expect(mappings).toContainEqual(expect.objectContaining({
      localName: '*', source: 'Lib.Hidden', isNamespace: false,
      excludedNames: expect.arrayContaining(['secret', 'Box']),
      excludedParentExports: ['Box'],
    }));
  });

  it('resolves constructors and class methods imported through Parent(..)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-children-'));
    fs.writeFileSync(path.join(tmpDir, 'Canonical.hs'), [
      'module Canonical (EventExpr (..), IsEvent (..)) where',
      'data EventExpr = EventInsert | EventDelete',
      'class IsEvent a where',
      '  runEvent :: a -> EventExpr',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Decoy.hs'), [
      'module Decoy where',
      'data EventExpr = EventDelete',
      'class IsEvent a where',
      '  runEvent :: a -> EventExpr',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Canonical (EventExpr (..), IsEvent (..))',
      'run value = EventDelete (runEvent value)',
      'wrap = EventDelete . runEvent',
    ].join('\n'));

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      await graph.indexAll(); // Incremental/full repetition must stay stable.
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const canonicalDelete = graph.getNodesByName('EventDelete')
        .find((node) => node.filePath === 'Canonical.hs')!;
      const decoyDelete = graph.getNodesByName('EventDelete')
        .find((node) => node.filePath === 'Decoy.hs')!;
      const canonicalMethod = graph.getNodesByName('runEvent')
        .find((node) => node.filePath === 'Canonical.hs')!;
      const outgoing = graph.getOutgoingEdges(run.id);
      const wrap = graph.getNodesByName('wrap').find((node) => node.filePath === 'Main.hs')!;
      const wrapOutgoing = graph.getOutgoingEdges(wrap.id);

      expect(outgoing.some((edge) => edge.target === canonicalDelete.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === canonicalMethod.id && edge.kind === 'calls')).toBe(true);
      expect(outgoing.some((edge) => edge.target === decoyDelete.id)).toBe(false);
      expect(wrapOutgoing.some((edge) => edge.target === canonicalDelete.id
        && edge.kind === 'references')).toBe(true);
      expect(wrapOutgoing.some((edge) => edge.target === canonicalMethod.id
        && edge.kind === 'references')).toBe(true);
      expect(graph.getNodesByName('run').filter((node) => node.filePath === 'Main.hs')).toHaveLength(1);
    } finally {
      graph.destroy();
    }
  });

  it('honours module export lists and import hiding', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-exports-'));
    fs.writeFileSync(path.join(tmpDir, 'Lib.hs'), [
      'module Lib (public, Box (Visible)) where',
      'public x = x',
      'private x = x',
      'data Box = Visible | Secret',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Lib hiding (public)',
      'run x = public (private (Visible (Secret x)))',
    ].join('\n'));

    const extracted = extractFromSource('Lib.hs', fs.readFileSync(path.join(tmpDir, 'Lib.hs'), 'utf8'));
    expect(extracted.nodes.find((node) => node.name === 'public')?.isExported).toBe(true);
    expect(extracted.nodes.find((node) => node.name === 'private')?.isExported).toBe(false);
    expect(extracted.nodes.find((node) => node.name === 'Visible')?.isExported).toBe(true);
    expect(extracted.nodes.find((node) => node.name === 'Secret')?.isExported).toBe(false);

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const targets = new Set(graph.getOutgoingEdges(run.id).map((edge) => edge.target));
      for (const name of ['public', 'private', 'Secret']) {
        const node = graph.getNodesByName(name).find((candidate) => candidate.filePath === 'Lib.hs')!;
        expect(targets.has(node.id)).toBe(false);
      }
      const visible = graph.getNodesByName('Visible').find((node) => node.filePath === 'Lib.hs')!;
      expect(targets.has(visible.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('follows a named re-export sourced from an unqualified wildcard import', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-reexport-'));
    fs.writeFileSync(path.join(tmpDir, 'Origin.hs'), 'module Origin (foo) where\nfoo x = x\n');
    fs.writeFileSync(path.join(tmpDir, 'Facade.hs'), 'module Facade (foo) where\nimport Origin\n');
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), 'module Main where\nimport Facade (foo)\nrun = foo 1\n');

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const foo = graph.getNodesByName('foo').find((node) => node.filePath === 'Origin.hs')!;
      expect(graph.getOutgoingEdges(run.id).some((edge) => edge.target === foo.id && edge.kind === 'calls')).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('does not resolve monadic and let-bound callables to imported decoys', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-monad-scope-'));
    fs.writeFileSync(path.join(tmpDir, 'Decoy.hs'), [
      'module Decoy where',
      'handler x = x',
      'local x = x',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'Main.hs'), [
      'module Main where',
      'import Decoy (handler, local)',
      'run request = do',
      '  handler <- acquire',
      '  let local = handler',
      '  handler request',
      '  local request',
    ].join('\n'));

    const graph = CodeGraph.initSync(tmpDir);
    try {
      await graph.indexAll();
      const run = graph.getNodesByName('run').find((node) => node.filePath === 'Main.hs')!;
      const outgoing = new Set(graph.getOutgoingEdges(run.id).map((edge) => edge.target));
      for (const name of ['handler', 'local']) {
        const decoy = graph.getNodesByName(name).find((node) => node.filePath === 'Decoy.hs')!;
        expect(outgoing.has(decoy.id)).toBe(false);
      }
    } finally {
      graph.destroy();
    }
  });

  it('shares grouped signatures without leaking declaration state across extractions', () => {
    const source = [
      'module Grouped where',
      'foo, bar :: Int -> Int',
      'foo 0 = 0',
      'foo x = x',
      'bar x = x',
    ].join('\n');

    for (let i = 0; i < 25; i++) {
      const result = extractFromSource('Grouped.hs', source);
      const foo = result.nodes.filter((node) => node.kind === 'function' && node.name === 'foo');
      const bar = result.nodes.filter((node) => node.kind === 'function' && node.name === 'bar');
      expect(foo).toHaveLength(1);
      expect(bar).toHaveLength(1);
      expect(foo[0]?.signature).toBe('foo, bar :: Int -> Int');
      expect(bar[0]?.signature).toBe('foo, bar :: Int -> Int');
      expect(foo[0]?.startColumn).toBe(0);
      expect(foo[0]?.endLine).toBe(4);
    }
  });
});

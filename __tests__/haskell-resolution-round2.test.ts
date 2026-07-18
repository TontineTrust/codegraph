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

describe('Haskell resolution round 2', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const createGraph = async (files: Record<string, string>): Promise<CodeGraph> => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-r2-'));
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    const graph = CodeGraph.initSync(tmpDir);
    await graph.indexAll();
    return graph;
  };

  const outgoingTargets = (graph: CodeGraph, owner: string, filePath: string) => {
    const node = graph.getNodesByName(owner).find((candidate) => candidate.filePath === filePath)!;
    return graph.getOutgoingEdges(node.id).map((edge) => ({
      edge,
      target: graph.getNode(edge.target)!,
    }));
  };

  it('resolves wildcard, qualified, prefix, and dash-prefixed symbolic operators', async () => {
    const graph = await createGraph({
      'Ops.hs': [
        'module Ops ((<+>), (-->) ) where',
        '(<+>) x _ = x',
        '(-->) x _ = x',
      ].join('\n'),
      'Wildcard.hs': [
        'module Wildcard where',
        'import Ops',
        'wild x y = x <+> y',
      ].join('\n'),
      'Qualified.hs': [
        'module Qualified where',
        'import qualified Ops as O',
        'qualified x y = x O.<+> y',
        'prefix x y = (O.<+>) x y',
      ].join('\n'),
      'Explicit.hs': [
        'module Explicit where',
        'import Ops (',
        '  (<+>), --- an ordinary three-dash comment, not an operator',
        '  (-->)',
        ')',
        'arrow x y = x --> y',
      ].join('\n'),
    });
    try {
      const operator = graph.getNodesByName('(<+>)').find((node) => node.filePath === 'Ops.hs')!;
      for (const [owner, filePath] of [
        ['wild', 'Wildcard.hs'],
        ['qualified', 'Qualified.hs'],
        ['prefix', 'Qualified.hs'],
      ] as const) {
        expect(outgoingTargets(graph, owner, filePath)
          .some(({ edge, target }) => edge.kind === 'calls' && target.id === operator.id)).toBe(true);
      }
      const arrow = graph.getNodesByName('(-->)').find((node) => node.filePath === 'Ops.hs')!;
      expect(outgoingTargets(graph, 'arrow', 'Explicit.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === arrow.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('keeps instance implementations lexical only inside their own equation', async () => {
    const graph = await createGraph({
      'Class.hs': [
        'module Class (C (..)) where',
        'class C a where',
        '  action :: a -> a',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Class (C (..))',
        'instance C Int where',
        '  action 0 = 0',
        '  action x = action (x - 1)',
        'use x = action x',
      ].join('\n'),
    });
    try {
      const selector = graph.getNodesByName('action')
        .find((node) => node.filePath === 'Class.hs')!;
      const implementation = graph.getNodesByName('action')
        .find((node) => node.filePath === 'Consumer.hs')!;
      expect(outgoingTargets(graph, 'use', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === selector.id)).toBe(true);
      expect(outgoingTargets(graph, 'use', 'Consumer.hs')
        .some(({ target }) => target.id === implementation.id)).toBe(false);
      expect(graph.getOutgoingEdges(implementation.id)
        .some((edge) => edge.kind === 'calls' && edge.target === implementation.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('resolves local, imported, and self-qualified record selectors and symbols', async () => {
    const graph = await createGraph({
      'Person.hs': [
        'module Person where',
        'data Person = Person { personName :: String }',
        'helper x = x',
        'local p = personName p',
        'selfField p = Person.personName p',
        'selfFunction = Person.helper 1',
        'selfConstructor = Person.Person "Ada"',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Person (Person (..))',
        'mapped xs = map personName xs',
      ].join('\n'),
    });
    try {
      const field = graph.getNodesByName('personName').find((node) => node.filePath === 'Person.hs')!;
      const helper = graph.getNodesByName('helper').find((node) => node.filePath === 'Person.hs')!;
      const constructor = graph.getNodesByName('Person')
        .find((node) => node.filePath === 'Person.hs' && node.kind === 'enum_member')!;
      for (const owner of ['local', 'selfField']) {
        expect(outgoingTargets(graph, owner, 'Person.hs')
          .some(({ target }) => target.id === field.id)).toBe(true);
      }
      expect(outgoingTargets(graph, 'selfFunction', 'Person.hs')
        .some(({ target }) => target.id === helper.id)).toBe(true);
      expect(outgoingTargets(graph, 'selfConstructor', 'Person.hs')
        .some(({ target }) => target.id === constructor.id)).toBe(true);
      expect(outgoingTargets(graph, 'mapped', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'references' && target.id === field.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('uses source position to distinguish repeated local helper scopes', async () => {
    const graph = await createGraph({
      'Main.hs': [
        'module Main where',
        'run b = if b',
        '  then let helper x = x',
        '       in helper 1',
        '  else let helper x = x + 1',
        '       in helper 2',
        'equations True = helper 1 where helper x = x',
        'equations False = helper 2 where helper x = x + 1',
      ].join('\n'),
    });
    try {
      const assertPositionedCalls = (owner: string, expected: Array<[number, number]>) => {
        const calls = outgoingTargets(graph, owner, 'Main.hs')
          .filter(({ edge, target }) => edge.kind === 'calls' && target.name === 'helper')
          .map(({ edge, target }) => [edge.line, target.startLine] as [number | undefined, number]);
        expect(calls).toEqual(expect.arrayContaining(expected));
      };
      assertPositionedCalls('run', [[4, 3], [6, 5]]);
      assertPositionedCalls('equations', [[7, 7], [8, 8]]);
    } finally {
      graph.destroy();
    }
  });

  it('resolves data-family instance constructors through Family(..)', async () => {
    const graph = await createGraph({
      'Family.hs': [
        '{-# LANGUAGE TypeFamilies #-}',
        'module Family (Family (..)) where',
        'data family Family a',
        'data instance Family Int = FamilyInt Int',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Family (Family (..))',
        'run = FamilyInt 1',
      ].join('\n'),
    });
    try {
      const constructor = graph.getNodesByName('FamilyInt')
        .find((node) => node.filePath === 'Family.hs')!;
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'calls' && target.id === constructor.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('keeps re-export cycle detection local to each alternative branch', async () => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin (foo) where\nfoo x = x\n',
      'A.hs': 'module A (module Origin) where\nimport Origin\n',
      'B.hs': 'module B (module Origin) where\nimport Origin\n',
      'Facade.hs': [
        'module Facade (module A, module B) where',
        'import A hiding (foo)',
        'import B',
      ].join('\n'),
      'Consumer.hs': 'module Consumer where\nimport Facade (foo)\nrun = foo 1\n',
    });
    try {
      const foo = graph.getNodesByName('foo').find((node) => node.filePath === 'Origin.hs')!;
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === foo.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('follows Haskell re-export chains deeper than eight modules', async () => {
    const files: Record<string, string> = {
      'M0.hs': 'module M0 (foo) where\nfoo x = x\n',
    };
    for (let index = 1; index <= 12; index++) {
      files[`M${index}.hs`] = [
        `module M${index} (module M${index - 1}) where`,
        `import M${index - 1}`,
      ].join('\n');
    }
    files['Consumer.hs'] = 'module Consumer where\nimport M12 (foo)\nrun = foo 1\n';
    const graph = await createGraph(files);
    try {
      const foo = graph.getNodesByName('foo').find((node) => node.filePath === 'M0.hs')!;
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === foo.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('invalidates unchanged consumers when an intermediate re-export changes or disappears', async () => {
    const graph = await createGraph({
      'A.hs': 'module A (foo) where\nfoo x = x\n',
      'B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'Facade.hs': 'module Facade (foo) where\nimport A (foo)\n',
      'Consumer.hs': 'module Consumer where\nimport Facade (foo)\nrun = foo 1\n',
    });
    const targetFile = () => outgoingTargets(graph, 'run', 'Consumer.hs')
      .find(({ edge, target }) => edge.kind === 'calls' && target.name === 'foo')?.target.filePath;
    try {
      expect(targetFile()).toBe('A.hs');

      fs.writeFileSync(path.join(tmpDir!, 'Facade.hs'), [
        'module Facade (foo) where',
        'import B (foo)',
        '-- switched source',
      ].join('\n'));
      await graph.sync();
      expect(targetFile()).toBe('B.hs');

      fs.writeFileSync(path.join(tmpDir!, 'Facade.hs'), 'module Facade () where\nimport B (foo)\n');
      await graph.sync();
      expect(targetFile()).toBeUndefined();

      fs.unlinkSync(path.join(tmpDir!, 'Facade.hs'));
      await graph.sync();
      expect(targetFile()).toBeUndefined();

      fs.writeFileSync(path.join(tmpDir!, 'Facade.hs'), [
        'module Facade (foo) where',
        'import B (foo)',
        '-- restored facade',
      ].join('\n'));
      await graph.sync();
      expect(targetFile()).toBe('B.hs');
    } finally {
      graph.destroy();
    }
  });

  it('re-resolves imports when a newly added exact module path beats an old candidate', async () => {
    const graph = await createGraph({
      'pkg/src/Wrong.hs': 'module Foo.Bar where\ntarget x = x\n',
      'pkg/app/Consumer.hs': 'module Consumer where\nimport Foo.Bar (target)\nrun = target 1\n',
    });
    const targetFile = () => outgoingTargets(graph, 'run', 'pkg/app/Consumer.hs')
      .find(({ edge, target }) => edge.kind === 'calls' && target.name === 'target')?.target.filePath;
    try {
      expect(targetFile()).toBe('pkg/src/Wrong.hs');
      const exactPath = path.join(tmpDir!, 'pkg/src/Foo/Bar.hs');
      fs.mkdirSync(path.dirname(exactPath), { recursive: true });
      fs.writeFileSync(exactPath, 'module Foo.Bar where\ntarget x = x + 1\n');
      await graph.sync();
      expect(targetFile()).toBe('pkg/src/Foo/Bar.hs');
    } finally {
      graph.destroy();
    }
  });

  it('resolves pattern synonyms bundled under a type export', async () => {
    const graph = await createGraph({
      'Patterns.hs': [
        '{-# LANGUAGE PatternSynonyms #-}',
        'module Patterns (T(P)) where',
        'data T = MkT',
        'pattern P = MkT',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE PatternSynonyms #-}',
        'module Consumer where',
        'import Patterns (T(P))',
        'run = P',
      ].join('\n'),
    });
    try {
      const pattern = graph.getNodesByName('P').find((node) => node.filePath === 'Patterns.hs')!;
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === pattern.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('resolves record pattern-synonym selectors locally and through explicit imports', async () => {
    const graph = await createGraph({
      'Patterns.hs': [
        '{-# LANGUAGE PatternSynonyms #-}',
        'module Patterns (pattern Present, presentValue) where',
        'pattern Present { presentValue } = Just presentValue',
        'local x = presentValue x',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Patterns (presentValue)',
        'run x = presentValue x',
      ].join('\n'),
    });
    try {
      const selector = graph.getNodesByName('presentValue')
        .find((node) => node.filePath === 'Patterns.hs')!;
      for (const [owner, filePath] of [['local', 'Patterns.hs'], ['run', 'Consumer.hs']] as const) {
        expect(outgoingTargets(graph, owner, filePath)
          .some(({ target }) => target.id === selector.id)).toBe(true);
      }
    } finally {
      graph.destroy();
    }
  });

  it('does not reinterpret a multi-segment imported module as a qualified member', async () => {
    const graph = await createGraph({
      'src/Legacy/TT/Common/RateLimit.hs': [
        'module Legacy.TT.Common.RateLimit where',
        'limit = 1',
      ].join('\n'),
      'src/Consumer.hs': [
        'module Consumer where',
        'import Legacy.TT.Common.RateLimit',
        'run = limit',
      ].join('\n'),
    });
    try {
      const consumerModule = graph.getNodesByName('Consumer')
        .find((node) => node.filePath === 'src/Consumer.hs' && node.kind === 'namespace')!;
      expect(graph.getOutgoingEdges(consumerModule.id).some((edge) => {
        const target = graph.getNode(edge.target);
        return edge.kind === 'imports'
          && target?.filePath === 'src/Legacy/TT/Common/RateLimit.hs';
      })).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('recovers atomically when Haskell import invalidation is interrupted', async () => {
    let graph = await createGraph({
      'A.hs': 'module A (foo) where\nfoo x = x\n',
      'B.hs': 'module B (foo) where\nfoo x = x + 1\n',
      'Facade.hs': 'module Facade (foo) where\nimport A (foo)\n',
      'Consumer.hs': 'module Consumer where\nimport Facade (foo)\nrun = foo 1\n',
    });
    const targetFile = () => outgoingTargets(graph, 'run', 'Consumer.hs')
      .find(({ edge, target }) => edge.kind === 'calls' && target.name === 'foo')?.target.filePath;
    try {
      expect(targetFile()).toBe('A.hs');
      fs.writeFileSync(path.join(tmpDir!, 'Facade.hs'), [
        'module Facade (foo) where',
        'import B (foo)',
        '-- force a changed size and mtime',
      ].join('\n'));

      const queries = (graph as unknown as {
        queries: { deleteEdgesBySource(nodeId: string): void };
      }).queries;
      const originalDelete = queries.deleteEdgesBySource.bind(queries);
      let injected = false;
      queries.deleteEdgesBySource = (nodeId: string) => {
        originalDelete(nodeId);
        if (!injected) {
          injected = true;
          throw new Error('injected Haskell invalidation interruption');
        }
      };
      await expect(graph.sync()).rejects.toThrow('injected Haskell invalidation interruption');

      graph.destroy();
      graph = CodeGraph.openSync(tmpDir!);
      // The facade file record already matches disk; recovery must therefore be
      // driven by the durable invalidation marker, not filesystem change data.
      await graph.sync();
      expect(targetFile()).toBe('B.hs');
    } finally {
      graph.destroy();
    }
  });

  it('keeps duplicate local helpers inside their exact equation scope', async () => {
    const filler = Array.from({ length: 28 }, (_, index) => `  step${index} = ${index}`).join('\n');
    const graph = await createGraph({
      'Main.hs': [
        'module Main where',
        'equations True = helper 1 where',
        filler,
        '  helper x = x',
        'equations False = helper 2 where',
        '  helper x = x + 1',
      ].join('\n'),
    });
    try {
      const helpers = graph.getNodesByName('helper').sort((a, b) => a.startLine - b.startLine);
      const calls = outgoingTargets(graph, 'equations', 'Main.hs')
        .filter(({ edge, target }) => edge.kind === 'calls' && target.name === 'helper');
      expect(calls.find(({ edge }) => edge.line === 2)?.target.id).toBe(helpers[0]!.id);
      expect(calls.find(({ edge }) => edge.line === 32)?.target.id).toBe(helpers[1]!.id);
    } finally {
      graph.destroy();
    }
  });

  it('lets a qualified import alias match the current module name when no local symbol exists', async () => {
    const graph = await createGraph({
      'X.hs': 'module X where\nfoo x = x\n',
      'A/B.hs': 'module A.B where\nimport qualified X as A.B\ny = A.B.foo\n',
    });
    try {
      const foo = graph.getNodesByName('foo').find((node) => node.filePath === 'X.hs')!;
      expect(outgoingTargets(graph, 'y', 'A/B.hs').some(({ target }) => target.id === foo.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('parses grouped children of operator type parents', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE TypeFamilies, TypeOperators #-}',
        'module Origin ((:*:)(..)) where',
        'data family a :*: b',
        'data instance Int :*: Bool = PairIB',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE TypeOperators #-}',
        'module Consumer where',
        'import Origin ((:*:)(..))',
        'run = PairIB',
      ].join('\n'),
    });
    try {
      const constructor = graph.getNodesByName('PairIB').find((node) => node.filePath === 'Origin.hs')!;
      expect(outgoingTargets(graph, 'run', 'Consumer.hs')
        .some(({ target }) => target.id === constructor.id)).toBe(true);
    } finally {
      graph.destroy();
    }
  });

  it('preserves DuplicateRecordFields parent identity through imports and re-exports', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Origin (A(field), B(field)) where',
        'data A = A { field :: Int }',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Facade.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Facade (B(field)) where',
        'import Origin (B(field))',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade (field)',
        'getB x = field x',
      ].join('\n'),
      'Qualified.hs': [
        'module Qualified where',
        'import qualified Origin as O (B(field))',
        'getQualified x = O.field x',
      ].join('\n'),
    });
    try {
      const fields = graph.getNodesByName('field').filter((node) => node.filePath === 'Origin.hs');
      const bField = fields.find((node) => node.qualifiedName.includes('::B::'))!;
      const aField = fields.find((node) => node.qualifiedName.includes('::A::'))!;
      for (const [owner, filePath] of [
        ['getB', 'Consumer.hs'], ['getQualified', 'Qualified.hs'],
      ] as const) {
        const targets = outgoingTargets(graph, owner, filePath).map(({ target }) => target.id);
        expect(targets).toContain(bField.id);
        expect(targets).not.toContain(aField.id);
      }
    } finally {
      graph.destroy();
    }
  });

  it('applies DuplicateRecordFields hiding before resolving a wildcard re-export', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Origin (A(..), B(..)) where',
        'data A = A { field :: Int }',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Facade.hs': [
        'module Facade (module Origin) where',
        'import Origin hiding (A(field))',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade (field)',
        'getB x = field x',
      ].join('\n'),
    });
    try {
      const fields = graph.getNodesByName('field').filter((node) => node.filePath === 'Origin.hs');
      const aField = fields.find((node) => node.qualifiedName.includes('::A::'))!;
      const bField = fields.find((node) => node.qualifiedName.includes('::B::'))!;
      const targets = outgoingTargets(graph, 'getB', 'Consumer.hs').map(({ target }) => target.id);
      expect(targets).toContain(bField.id);
      expect(targets).not.toContain(aField.id);
    } finally {
      graph.destroy();
    }
  });

  it('uses an annotated record-dot receiver and leaves an unknown receiver unresolved', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        'module Origin (B(..)) where',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Consumer.hs': [
        '{-# LANGUAGE DuplicateRecordFields, OverloadedRecordDot #-}',
        'module Consumer where',
        'import Origin (B(..))',
        'data A = A { field :: Int }',
        'getB :: B -> Int',
        'getB value = value.field',
        'getA :: A -> Int',
        'getA value = value.field',
        'unknown value = value.field',
        'unknownParenthesized value = (value).field',
      ].join('\n'),
      'QualifiedDot.hs': [
        '{-# LANGUAGE DuplicateRecordFields, OverloadedRecordDot #-}',
        'module QualifiedDot where',
        'import qualified Origin as O',
        'data B = B { field :: Int }',
        'getQualified :: O.B -> Int',
        'getQualified value = value.field',
      ].join('\n'),
    });
    try {
      const importedField = graph.getNodesByName('field')
        .find((node) => node.filePath === 'Origin.hs')!;
      const localField = graph.getNodesByName('field')
        .find((node) => node.filePath === 'Consumer.hs')!;
      expect(outgoingTargets(graph, 'getB', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'references' && target.id === importedField.id)).toBe(true);
      expect(outgoingTargets(graph, 'getB', 'Consumer.hs')
        .some(({ target }) => target.id === localField.id)).toBe(false);
      expect(outgoingTargets(graph, 'getA', 'Consumer.hs')
        .some(({ edge, target }) => edge.kind === 'references' && target.id === localField.id)).toBe(true);
      expect(outgoingTargets(graph, 'unknown', 'Consumer.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
      expect(outgoingTargets(graph, 'unknownParenthesized', 'Consumer.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
      expect(outgoingTargets(graph, 'getQualified', 'QualifiedDot.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
    } finally {
      graph.destroy();
    }
  });

  it('does not let a direct Haskell export hide an ambiguous wildcard re-export', async () => {
    const graph = await createGraph({
      'Origin.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Origin (A(..), B(..)) where',
        'data A = A { field :: Int }',
        'data B = B { field :: Int }',
      ].join('\n'),
      'Facade.hs': [
        '{-# LANGUAGE DuplicateRecordFields #-}',
        'module Facade (C(..), module Origin) where',
        'import Origin',
        'data C = C { field :: Int }',
      ].join('\n'),
      'Consumer.hs': [
        'module Consumer where',
        'import Facade (field)',
        'use value = field value',
      ].join('\n'),
    });
    try {
      expect(outgoingTargets(graph, 'use', 'Consumer.hs')
        .some(({ target }) => target.name === 'field')).toBe(false);
    } finally {
      graph.destroy();
    }
  });

  it('keeps same-line local helper IDs distinct and resolves each call to its own scope', async () => {
    const filler = Array.from({ length: 36 }, () => '0 + ').join('');
    const graph = await createGraph({
      'Main.hs': [
        'module Main where',
        `run b = if b then let helper x = x + 1 in ${filler}helper 1 else let helper x = x + 2 in helper 2`,
      ].join('\n'),
    });
    try {
      const helpers = graph.getNodesByName('helper')
        .filter((node) => node.filePath === 'Main.hs')
        .sort((a, b) => a.startColumn - b.startColumn);
      expect(helpers).toHaveLength(2);
      expect(helpers[0]!.id).not.toBe(helpers[1]!.id);
      const calls = outgoingTargets(graph, 'run', 'Main.hs')
        .filter(({ edge, target }) => edge.kind === 'calls' && target.name === 'helper')
        .sort((a, b) => (a.edge.column ?? 0) - (b.edge.column ?? 0));
      expect(calls).toHaveLength(2);
      expect(calls[0]!.target.id).toBe(helpers[0]!.id);
      expect(calls[1]!.target.id).toBe(helpers[1]!.id);

      const originalIds = helpers.map((helper) => helper.id);
      fs.appendFileSync(path.join(tmpDir!, 'Main.hs'), '\n-- force a stable re-index\n');
      await graph.sync();
      expect(graph.getNodesByName('helper')
        .filter((node) => node.filePath === 'Main.hs')
        .sort((a, b) => a.startColumn - b.startColumn)
        .map((helper) => helper.id)).toEqual(originalIds);
    } finally {
      graph.destroy();
    }
  });

  it('resolves imported, qualified, and self-alias constants used as values', async () => {
    const graph = await createGraph({
      'X.hs': 'module X (foo) where\nfoo = 1\n',
      'Direct.hs': 'module Direct where\nimport X (foo)\ny = foo\n',
      'Qualified.hs': 'module Qualified where\nimport qualified X as Q\nyq = Q.foo\n',
      'A/B.hs': 'module A.B where\nimport qualified X as A.B\nys = A.B.foo\n',
    });
    try {
      const foo = graph.getNodesByName('foo')
        .find((node) => node.filePath === 'X.hs' && node.kind === 'constant')!;
      expect(foo).toBeDefined();
      for (const [owner, filePath] of [
        ['y', 'Direct.hs'],
        ['yq', 'Qualified.hs'],
        ['ys', 'A/B.hs'],
      ] as const) {
        expect(outgoingTargets(graph, owner, filePath)
          .some(({ edge, target }) => edge.kind === 'references' && target.id === foo.id)).toBe(true);
      }
    } finally {
      graph.destroy();
    }
  });
});

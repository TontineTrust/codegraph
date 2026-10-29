import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Haskell import visibility review regressions', () => {
  const fixtures: Array<{ graph: CodeGraph; directory: string }> = [];

  afterEach(() => {
    for (const { graph, directory } of fixtures.splice(0)) {
      graph.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  async function createGraph(files: Record<string, string>): Promise<CodeGraph> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-import-visibility-'));
    for (const [file, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(directory, file), source);
    }
    const graph = CodeGraph.initSync(directory);
    fixtures.push({ graph, directory });
    expect((await graph.indexAll()).success).toBe(true);
    return graph;
  }

  function dependencies(graph: CodeGraph, file: string, name: string) {
    const owner = graph.getNodesByName(name).find((node) => node.filePath === file)!;
    expect(owner).toBeDefined();
    return graph.getOutgoingEdges(owner.id)
      .filter((edge) => edge.kind === 'calls' || edge.kind === 'references')
      .map((edge) => ({ kind: edge.kind, target: graph.getNode(edge.target)!.qualifiedName }));
  }

  it.each(['T', 'T()'])('does not import a same-named constructor through the type item %s', async (item) => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\ndata T = T Int\n',
      'Other.hs': 'module Other where\ndata U = T Int\n',
      'Consumer.hs': `module Consumer where\nimport Origin (${item})\nimport Other (U(T))\nmake n = T n\n`,
    });
    expect(dependencies(graph, 'Consumer.hs', 'make')).toEqual([
      { kind: 'calls', target: 'Other::U::T' },
    ]);
  });

  it('keeps hiding both namespaces while explicit pattern imports select constructors', async () => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\ndata T = T Int\n',
      'Other.hs': 'module Other where\ndata U = T Int\n',
      'Hidden.hs': 'module Hidden where\nimport Origin hiding (T)\nimport Other (U(T))\nmake n = T n\n',
      'Pattern.hs': '{-# LANGUAGE PatternSynonyms #-}\nmodule Pattern where\nimport Origin (pattern T)\nmake n = T n\n',
      'Type.hs': '{-# LANGUAGE ExplicitNamespaces #-}\nmodule Type where\nimport Origin (type T)\nimport Other (U(T))\nmake n = T n\n',
    });
    expect(dependencies(graph, 'Hidden.hs', 'make')).toEqual([
      { kind: 'calls', target: 'Other::U::T' },
    ]);
    expect(dependencies(graph, 'Pattern.hs', 'make')).toEqual([
      { kind: 'calls', target: 'Origin::T::T' },
    ]);
    expect(dependencies(graph, 'Type.hs', 'make')).toEqual([
      { kind: 'calls', target: 'Other::U::T' },
    ]);
  });

  it.each(['Records', 'Records (A(..), B(..))'])('resolves the annotated owner before duplicate fields from %s', async (imported) => {
    const graph = await createGraph({
      'Records.hs': '{-# LANGUAGE DuplicateRecordFields #-}\nmodule Records where\ndata A = A { value :: Int }\ndata B = B { value :: Bool }\n',
      'Consumer.hs': `{-# LANGUAGE OverloadedRecordDot #-}\nmodule Consumer where\nimport ${imported}\nreadA :: A -> Int\nreadA item = item.value\n`,
    });
    expect(dependencies(graph, 'Consumer.hs', 'readA')).toEqual([
      { kind: 'references', target: 'Records::A::value' },
    ]);
  });

  it('uses the imported type identity when another field has a same-named parent', async () => {
    const graph = await createGraph({
      'Records.hs': 'module Records where\ndata A = A { value :: Int }\n',
      'Other.hs': 'module Other where\ndata A = A { value :: Bool }\n',
      'Consumer.hs': '{-# LANGUAGE OverloadedRecordDot #-}\nmodule Consumer where\nimport Records (A(..))\nimport Other (value)\nreadA :: A -> Int\nreadA item = item.value\n',
    });
    expect(dependencies(graph, 'Consumer.hs', 'readA')).toEqual([
      { kind: 'references', target: 'Records::A::value' },
    ]);
  });

  it('does not resolve hidden fields or an ambiguous receiver type', async () => {
    const graph = await createGraph({
      'Records.hs': 'module Records where\ndata A = A { value :: Int }\n',
      'Hidden.hs': '{-# LANGUAGE OverloadedRecordDot #-}\nmodule Hidden where\nimport Records (A)\nreadA :: A -> Int\nreadA item = item.value\n',
      'Ambiguous.hs': '{-# LANGUAGE OverloadedRecordDot #-}\nmodule Ambiguous where\nimport Records (A(..))\ndata A = LocalA { value :: Int }\nreadA :: A -> Int\nreadA item = item.value\n',
    });
    expect(dependencies(graph, 'Hidden.hs', 'readA')).toEqual([]);
    expect(dependencies(graph, 'Ambiguous.hs', 'readA')).toEqual([]);
  });

  it('rechecks a projection in an unchanged consumer when a facade hides its field', async () => {
    const graph = await createGraph({
      'Records.hs': '{-# LANGUAGE DuplicateRecordFields #-}\nmodule Records where\ndata A = A { value :: Int }\ndata B = B { value :: Bool }\n',
      'Facade.hs': 'module Facade (A(..)) where\nimport Records (A(value))\n',
      'Consumer.hs': '{-# LANGUAGE OverloadedRecordDot #-}\nmodule Consumer where\nimport Facade\nreadA :: A -> Int\nreadA item = item.value\n',
    });
    const expected = [{ kind: 'references', target: 'Records::A::value' }];
    expect(dependencies(graph, 'Consumer.hs', 'readA')).toEqual(expected);
    const directory = fixtures.find((fixture) => fixture.graph === graph)!.directory;
    fs.writeFileSync(path.join(directory, 'Facade.hs'), 'module Facade (A) where\nimport Records (A(value))\n');
    await graph.sync({ paths: ['Facade.hs'] });
    expect(dependencies(graph, 'Consumer.hs', 'readA')).toEqual([]);
    fs.writeFileSync(path.join(directory, 'Facade.hs'), 'module Facade (A(..)) where\nimport Records (A(value))\n');
    await graph.sync({ paths: ['Facade.hs'] });
    expect(dependencies(graph, 'Consumer.hs', 'readA')).toEqual(expected);
  });

  it('retains qualified selected constructors when a facade exports all visible children', async () => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\ndata T = MkT Int | Hidden Int\n',
      'Facade.hs': 'module Facade (O.T(..)) where\nimport qualified Origin as O (T(MkT))\n',
      'Consumer.hs': 'module Consumer where\nimport Facade\nmake = MkT 1\nnotVisible = Hidden 1\n',
    });
    expect(dependencies(graph, 'Consumer.hs', 'make')).toEqual([
      { kind: 'calls', target: 'Origin::T::MkT' },
    ]);
    expect(dependencies(graph, 'Consumer.hs', 'notVisible')).toEqual([]);
  });

  it.each(['A(..)', 'O.A(..)'])('preserves selected field ownership through a %s facade', async (exported) => {
    const imported = exported.startsWith('O.') ? 'qualified Origin as O' : 'Origin';
    const graph = await createGraph({
      'Origin.hs': '{-# LANGUAGE DuplicateRecordFields #-}\nmodule Origin where\ndata A = A { value :: Int }\ndata B = B { value :: Bool }\n',
      'Facade.hs': `module Facade (${exported}) where\nimport ${imported} (A(value))\n`,
      'Consumer.hs': 'module Consumer where\nimport Facade\nreadA item = value item\n',
    });
    expect(dependencies(graph, 'Consumer.hs', 'readA')).toEqual([
      { kind: 'calls', target: 'Origin::A::value' },
    ]);
  });

  it.each([
    ['T(..)', 'Origin (T, value)'],
    ['O.T(..)', 'qualified Origin as O (T, value)'],
    ['value', 'Origin (T(value))'],
    ['value', 'Origin (T(..))'],
    ['O.value', 'qualified Origin as O (T(value))'],
    ['O.value', 'qualified Origin as O (T(..))'],
  ])('preserves child visibility when %s regroups import %s', async (exported, imported) => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\ndata T = MkT { value :: Int }\n',
      'Facade.hs': `module Facade (${exported}) where\nimport ${imported}\n`,
      'Consumer.hs': 'module Consumer where\nimport Facade\nreadValue item = value item\n',
    });
    expect(dependencies(graph, 'Consumer.hs', 'readValue')).toEqual([
      { kind: 'calls', target: 'Origin::T::value' },
    ]);
  });

  it.each([
    ['value', 'Origin (A(value))'],
    ['O.value', 'qualified Origin as O (A(value))'],
  ])('keeps duplicate-field ownership when %s exports import %s by its leaf', async (exported, imported) => {
    const graph = await createGraph({
      'Origin.hs': '{-# LANGUAGE DuplicateRecordFields #-}\nmodule Origin where\ndata A = MkA { value :: Int }\ndata B = MkB { value :: Bool }\n',
      'Facade.hs': `module Facade (${exported}) where\nimport ${imported}\n`,
      'Consumer.hs': 'module Consumer where\nimport Facade\nreadValue item = value item\n',
    });
    expect(dependencies(graph, 'Consumer.hs', 'readValue')).toEqual([
      { kind: 'calls', target: 'Origin::A::value' },
    ]);
  });

  it('does not add unimported constructors when separately imported children are regrouped', async () => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\ndata T = MkT { value :: Int }\n',
      'Facade.hs': 'module Facade (T(..)) where\nimport Origin (T, value)\n',
      'Consumer.hs': 'module Consumer where\nimport Facade\nreadValue item = value item\nnotVisible = MkT 1\n',
    });
    expect(dependencies(graph, 'Consumer.hs', 'readValue')).toEqual([
      { kind: 'calls', target: 'Origin::T::value' },
    ]);
    expect(dependencies(graph, 'Consumer.hs', 'notVisible')).toEqual([]);
  });

  it('keeps grouped hiding restrictions when exporting a field by its leaf', async () => {
    const graph = await createGraph({
      'Origin.hs': '{-# LANGUAGE DuplicateRecordFields #-}\nmodule Origin where\ndata A = MkA { value :: Int }\ndata B = MkB { value :: Bool }\n',
      'Facade.hs': 'module Facade (value) where\nimport Origin hiding (A(value))\n',
      'Consumer.hs': 'module Consumer where\nimport Facade\nreadValue item = value item\n',
    });
    expect(dependencies(graph, 'Consumer.hs', 'readValue')).toEqual([
      { kind: 'calls', target: 'Origin::B::value' },
    ]);
  });

  it('does not treat another grouped import as an unrestricted child import', async () => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\ndata T = MkT Int\ndata Other = Other Int\n',
      'Facade.hs': 'module Facade (T(..)) where\nimport Origin (T, Other(..))\n',
      'Consumer.hs': 'module Consumer where\nimport Facade\nnotVisible = MkT 1\n',
    });
    expect(dependencies(graph, 'Consumer.hs', 'notVisible')).toEqual([]);
  });

  it.each([
    'module Consumer where { import Origin; readValue item = value item }',
    'module Consumer (readValue) where {\n import Origin;\n readValue item = value item\n }',
  ])('discovers imports in an explicit module layout: %s', async (source) => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\nvalue n = n + 1\n',
      'Consumer.hs': source,
    });
    expect(dependencies(graph, 'Consumer.hs', 'readValue')).toEqual([
      { kind: 'calls', target: 'Origin::value' },
    ]);
  });

  it('discovers imports in a headerless explicit-layout Main module', async () => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\nvalue n = n + 1\n',
      'Main.hs': '{ import Origin; main = print (value 1) }\n',
    });
    expect(dependencies(graph, 'Main.hs', 'main')).toEqual([
      { kind: 'calls', target: 'Origin::value' },
    ]);
  });

  it.each(['"; import Other; value"', '[q| ; import Other; value |]'])('ignores source-looking literal %s in explicit layout', async (literal) => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\nvalue n = n + 1\n',
      'Other.hs': 'module Other where\nvalue n = n - 1\n',
      'Consumer.hs': [
        '{-# LANGUAGE QuasiQuotes #-}',
        'module Consumer where { {- import Other; -} import Origin;',
        ` payload = ${literal};`,
        ' readValue item = value item }',
      ].join('\n'),
    });
    expect(dependencies(graph, 'Consumer.hs', 'readValue')).toEqual([
      { kind: 'calls', target: 'Origin::value' },
    ]);
  });

  it('preserves package strings and multiple explicit-layout imports', async () => {
    const graph = await createGraph({
      'Origin.hs': 'module Origin where\nvalue n = n + 1\n',
      'Consumer.hs': '{-# LANGUAGE PackageImports #-}\nmodule Consumer where { import "base" Prelude; import qualified Origin as O (value); readValue item = O.value item }\n',
    });
    expect(dependencies(graph, 'Consumer.hs', 'readValue')).toEqual([
      { kind: 'calls', target: 'Origin::value' },
    ]);
  });
});

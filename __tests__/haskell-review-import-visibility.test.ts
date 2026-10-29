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
});

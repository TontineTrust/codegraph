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

describe('Haskell same-named type and imported constructor', () => {
  let root: string | undefined;
  let graph: CodeGraph | undefined;
  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function index(files: Record<string, string>, hops = 0) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-constructor-import-'));
    for (let i = 0; i <= hops && hops > 0; i++) {
      files[`Deep${i}.hs`] = i === hops
        ? `module Deep${i} where\n`
        : `module Deep${i} (module Deep${i + 1}) where\nimport Deep${i + 1}\n`;
    }
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
    graph = CodeGraph.initSync(root);
    expect((await graph.indexAll()).success).toBe(true);
    return graph;
  }
  function calls(current: CodeGraph, owner = 'run') {
    const caller = current.getNodesByName(owner).find((node) => node.filePath === 'Consumer.hs')!;
    return current.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls')
      .map((edge) => current.getNode(edge.target)!);
  }

  describe.each([0, 65])('with %i unrelated facade hops', (hops) => {
    it.each([
      ['FieldLabelString', 'newtype FieldLabelString = FieldLabelString { field_label :: Int }', 'run x = let x_fl = FieldLabelString x in x_fl'],
      ['ConInfo', 'data ConInfo = ConInfo { left :: Int, right :: Int }', 'run xs = [ConInfo x x | x <- xs]'],
    ])('resolves %s through an explicit parent-wide import from an implicit export', async (name, declaration, body) => {
      const current = await index({
        'Origin.hs': `module Origin where\n${declaration}\n`,
        'Consumer.hs': `module Consumer where\n${hops ? 'import Deep0\n' : ''}import Origin (${name}(..))\n${body}\n`,
      }, hops);
      const constructor = current.getNodesByName(name).find((node) => node.filePath === 'Origin.hs' && node.kind === 'enum_member')!;
      expect(constructor).toBeDefined();
      expect(calls(current)).toContainEqual(expect.objectContaining({ id: constructor.id }));
    });
  });

  it.each(['T', 'T()', 'Other(..)'])('does not authorize a constructor through %s', async (selection) => {
    const current = await index({
      'Origin.hs': 'module Origin where\ndata T = T Int\ndata Other = Other Int\n',
      'Consumer.hs': `module Consumer where\nimport Origin (${selection})\nrun = T 1\n`,
    });
    expect(calls(current).some((node) => node.name === 'T')).toBe(false);
  });

  it('does not treat a parent without a same-spelled child as a failed explicit value import', async () => {
    const current = await index({
      'Origin.hs': 'module Origin where\ndata T = A Int\n',
      'Other.hs': 'module Other where\ndata U = T Int\n',
      'Consumer.hs': 'module Consumer where\nimport Origin (T(..))\nimport Other\nrun = T 1\n',
    });
    expect(calls(current)).toContainEqual(expect.objectContaining({
      name: 'T', kind: 'enum_member', filePath: 'Other.hs',
    }));
  });

  it.each([false, true])('preserves a distinct constructor competitor with deep facade=%s', async (deep) => {
    const current = await index({
      'Origin.hs': 'module Origin where\ndata T = T Int\n',
      'Other.hs': 'module Other where\ndata U = T Int\n',
      'Consumer.hs': `module Consumer where\nimport Origin (T(..))\nimport Other\n${deep ? 'import Deep0\n' : ''}run = T 1\n`,
    }, deep ? 65 : 0);
    expect(calls(current).some((node) => node.name === 'T')).toBe(false);
  });

  it('keeps an unresolved explicit package value import authoritative', async () => {
    const current = await index({
      'Origin.hs': 'module Origin where\ndata T = T Int\n',
      'Consumer.hs': '{-# LANGUAGE PackageImports, PatternSynonyms #-}\nmodule Consumer where\nimport Origin (T(..))\nimport "other-package" External (pattern T)\nrun = T 1\n',
    });
    expect(calls(current).some((node) => node.name === 'T')).toBe(false);
  });

  describe.each([
    ['package-qualified', 'import "other-package" Origin (T(..))'],
    ['unindexed', 'import Missing (T(..))'],
  ])('with a %s parent-wide import', (_label, externalImport) => {
    it.each([false, true])('retains the existing external wildcard policy with external-first=%s', async (externalFirst) => {
      const imports = [externalImport, 'import Origin (T(..))'];
      if (!externalFirst) imports.reverse();
      const current = await index({
        'Origin.hs': 'module Origin where\ndata T = T Int\n',
        'Consumer.hs': `{-# LANGUAGE PackageImports #-}\nmodule Consumer where\n${imports.join('\n')}\nrun = T 1\n`,
      });
      expect(calls(current).filter((node) => node.name === 'T')).toEqual([
        expect.objectContaining({ kind: 'enum_member', filePath: 'Origin.hs' }),
      ]);
    });
  });

  it.each([false, true])('rejects two distinct parent-wide constructor imports with reversed=%s', async (reversed) => {
    const imports = ['import Origin (T(..))', 'import Other (T(..))'];
    if (reversed) imports.reverse();
    const current = await index({
      'Origin.hs': 'module Origin where\ndata T = T Int\n',
      'Other.hs': 'module Other where\ndata T = T Int\n',
      'Consumer.hs': `module Consumer where\n${imports.join('\n')}\nrun = T 1\n`,
    });
    expect(calls(current).some((node) => node.name === 'T')).toBe(false);
  });

  it('does not discard an ambiguous parent-wide facade after finding a separate authorized witness', async () => {
    const current = await index({
      'Origin.hs': 'module Origin where\ndata T = T Int\n',
      'Other.hs': 'module Other where\ndata T = T Int\n',
      'Facade.hs': 'module Facade (module Origin, module Other) where\nimport Origin\nimport Other\n',
      'Consumer.hs': 'module Consumer where\nimport Facade (T(..))\nimport Origin (T(..))\nrun = T 1\n',
    });
    expect(calls(current).some((node) => node.name === 'T')).toBe(false);
  });

  it('respects a facade exporting only the type', async () => {
    const current = await index({
      'Origin.hs': 'module Origin where\ndata T = T Int\n',
      'Facade.hs': 'module Facade (T) where\nimport Origin (T(..))\n',
      'Consumer.hs': 'module Consumer where\nimport Facade (T(..))\nrun = T 1\n',
    });
    expect(calls(current).some((node) => node.name === 'T')).toBe(false);
  });

  it('deduplicates two parent imports of the same original constructor', async () => {
    const current = await index({
      'Origin.hs': 'module Origin where\ndata T = T Int\n',
      'Facade.hs': 'module Facade (module Origin) where\nimport Origin\n',
      'Consumer.hs': 'module Consumer where\nimport Facade (T(..))\nimport Origin (T(..))\nrun = T 1\n',
    });
    expect(calls(current).filter((node) => node.name === 'T')).toEqual([
      expect.objectContaining({ kind: 'enum_member', filePath: 'Origin.hs' }),
    ]);
  });
});

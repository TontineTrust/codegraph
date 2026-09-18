import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractImportMappings, extractReExports } from '../src/resolution/import-resolver';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['haskell']);
});

describe('Haskell import audit regressions', () => {
  let root: string | undefined;
  let graph: CodeGraph | undefined;
  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });
  async function index(files: Record<string, string>) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-import-audit-'));
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
    graph = CodeGraph.initSync(root);
    expect((await graph.indexAll()).success).toBe(true);
    return graph;
  }
  function targets(current: CodeGraph, owner: string, file = 'Consumer.hs') {
    const caller = current.getNodesByName(owner).find((node) => node.filePath === file)!;
    return current.getOutgoingEdges(caller.id).map((edge) => ({ edge, target: current.getNode(edge.target)! }));
  }

  it('preserves long dash operators and comment boundaries in import surfaces', () => {
    const operator = `${'-'.repeat(65536)}+`;
    const source = [
      `module Facade ((${operator})) where`,
      `import Origin ((${operator}))`,
      '--- Haddock comment: import Hidden',
      'import Visible (visible)',
      '',
    ].join('\n');
    expect(extractImportMappings('Facade.hs', source, 'haskell')).toContainEqual(expect.objectContaining({
      localName: operator, source: 'Origin',
    }));
    expect(extractReExports(source, 'haskell')).toContainEqual(expect.objectContaining({
      kind: 'wildcard', source: 'Origin', includedNames: [operator],
    }));
    expect(extractImportMappings('Facade.hs', source, 'haskell').some((mapping) => mapping.source === 'Hidden'))
      .toBe(false);
  });

  it.each(['T(Selected)', 'T(Selected), T(Other)'])(
    'preserves qualified visible children from grouped import %s', async (selected) => {
    const current = await index({
      'Origin.hs': 'module Origin (T(..)) where\ndata T = Selected Int | Other Int | Hidden Int\n',
      'Facade.hs': `module Facade (O.T(..)) where\nimport qualified Origin as O (${selected})\n`,
      'Consumer.hs': 'module Consumer where\nimport Facade\nrun = Selected 1\nother = Other 1\nmissing = Hidden 1\n',
    });
    expect(targets(current, 'run')).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ name: 'Selected', filePath: 'Origin.hs' }),
    }));
    expect(targets(current, 'other').some(({ target }) => target.name === 'Other')).toBe(selected.includes('Other'));
    expect(targets(current, 'missing').some(({ target }) => target.name === 'Hidden')).toBe(false);
  });

  it.each([false, true])('re-exports individually imported children with qualified=%s', async (qualified) => {
    const current = await index({
      'Origin.hs': 'module Origin (T(..), unrelated) where\ndata T = Selected Int | Hidden Int\nunrelated x = x\n',
      'Facade.hs': [
        '{-# LANGUAGE ExplicitNamespaces, PatternSynonyms #-}',
        `module Facade (${qualified ? 'O.' : ''}T(..)) where`,
        `import ${qualified ? 'qualified ' : ''}Origin as O (type T, pattern Selected, unrelated)`,
      ].join('\n'),
      'Consumer.hs': 'module Consumer where\nimport Facade\nrun = Selected 1\nmissing = Hidden 1\nfree = unrelated 1\n',
    });
    expect(targets(current, 'run')).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ name: 'Selected', filePath: 'Origin.hs' }),
    }));
    expect(targets(current, 'missing').some(({ target }) => target.name === 'Hidden')).toBe(false);
    expect(targets(current, 'free').some(({ target }) => target.name === 'unrelated')).toBe(false);
  });

  it.each([
    ['unrelated parent import', 'import Prelude (Maybe(..))', 'map'],
    ['hidden class methods', 'import Prelude hiding (Functor(..))', 'fmap'],
    ['qualified parent import', 'import qualified Prelude as P (Maybe(..))', 'P.map'],
    ['hidden selected class method', 'import Prelude hiding (Functor(fmap))', 'fmap'],
    ['qualified hidden class methods', 'import qualified Prelude as P hiding (Functor(..))', 'P.fmap'],
    ['qualified hidden operator methods', 'import qualified Prelude as P hiding (Applicative(..))', '(P.*>)'],
  ])('does not infer callback execution through %s', async (_label, declaration, combinator) => {
    const current = await index({
      'Callback.hs': 'module Callback (callback) where\ncallback x = x\n',
      'Consumer.hs': `module Consumer where\n${declaration}\nimport qualified Callback as C\nrun xs = ${combinator} C.callback xs\n`,
    });
    const callbackEdges = targets(current, 'run').filter(({ target }) => target.name === 'callback');
    expect(callbackEdges.length).toBeGreaterThan(0);
    expect(callbackEdges.some(({ edge }) => edge.kind === 'calls')).toBe(false);
  });

  it.each(['T', 'T()'])('keeps constructor T hidden when only the type is imported as %s', async (selection) => {
    const current = await index({
      'Origin.hs': 'module Origin (T(..)) where\ndata T = T Int\n',
      'Consumer.hs': `module Consumer where\nimport Origin (${selection})\nrun = T 1\n`,
    });
    expect(targets(current, 'run').some(({ target }) => target.kind === 'enum_member')).toBe(false);
  });

  it.each([
    ['type T', 'O.T', false],
    ['T(..)', 'O.T', false],
    ['pattern T', 'pattern O.T', true],
    ['type T)\nimport qualified Origin as O (pattern T', 'O.T, pattern O.T', true],
    ['pattern T)\nimport qualified Origin as O (type T', 'O.T, pattern O.T', true],
  ] as const)('preserves namespace visibility from %s through export %s', async (imports, exports, hasConstructor) => {
    const current = await index({
      'Origin.hs': 'module Origin (T(..)) where\ndata T = T Int\n',
      'Facade.hs': `{-# LANGUAGE ExplicitNamespaces, PatternSynonyms #-}\nmodule Facade (${exports}) where\nimport qualified Origin as O (${imports})\n`,
      'Consumer.hs': 'module Consumer where\nimport Facade\nrun = T 1\n',
    });
    expect(targets(current, 'run').some(({ target }) => target.kind === 'enum_member' && target.name === 'T'))
      .toBe(hasConstructor);
  });

  it.each([
    ['import Prelude (Functor(..))', 'fmap'],
    ['import Prelude (Functor(fmap))', 'fmap'],
    ['import qualified Prelude as P (Functor(..))', 'P.fmap'],
    ['import Prelude hiding (Maybe(..))', 'map'],
    ['import Prelude (Maybe(..))\nimport Prelude (map)', 'map'],
    ['import Prelude (Functor(fmap))\nimport Prelude (Maybe(..))', 'fmap'],
    ['import qualified Data.List as L', 'L.foldr'],
  ])('retains canonical callback execution for %s', async (declaration, combinator) => {
    const current = await index({
      'Callback.hs': 'module Callback (callback) where\ncallback x = x\n',
      'Consumer.hs': `module Consumer where\n${declaration}\nimport qualified Callback as C\nrun xs = ${combinator} C.callback xs\n`,
    });
    expect(targets(current, 'run')).toContainEqual(expect.objectContaining({
      edge: expect.objectContaining({ kind: 'calls', provenance: 'heuristic' }),
      target: expect.objectContaining({ name: 'callback' }),
    }));
  });

  it('intersects parent restrictions through facades and rechecks their restoration', async () => {
    const permitted = 'module Facade (module P) where\nimport Prelude as P (Functor(..))\n';
    const forbidden = 'module Facade (module P) where\nimport Prelude as P hiding (Functor(..))\n';
    const current = await index({
      'Callback.hs': 'module Callback (callback) where\ncallback x = x\n',
      'Facade.hs': permitted,
      'Consumer.hs': 'module Consumer where\nimport Prelude hiding (fmap)\nimport Facade\nimport qualified Callback as C\nrun xs = fmap C.callback xs\n',
    });
    const snapshot = () => targets(current, 'run').filter(({ target }) => target.name === 'callback')
      .map(({ edge }) => ({ kind: edge.kind, metadata: edge.metadata, provenance: edge.provenance }));
    const initial = snapshot();
    expect(initial.some(({ kind }) => kind === 'calls')).toBe(true);
    fs.writeFileSync(path.join(root!, 'Facade.hs'), forbidden);
    await current.sync({ paths: ['Facade.hs'] });
    expect(snapshot().some(({ kind }) => kind === 'calls')).toBe(false);
    fs.writeFileSync(path.join(root!, 'Facade.hs'), permitted);
    await current.sync({ paths: ['Facade.hs'] });
    expect(snapshot()).toEqual(initial);
  });

  it('keeps restrictions separate when a diamond re-exports one canonical module twice', async () => {
    const current = await index({
      'Callback.hs': 'module Callback (callback) where\ncallback x = x\n',
      'Allowed.hs': 'module Allowed (module P) where\nimport Prelude as P (Functor(..))\n',
      'Denied.hs': 'module Denied (module P) where\nimport Prelude as P (Maybe(..))\n',
      'Facade.hs': 'module Facade (module Allowed, module Denied) where\nimport Allowed\nimport Denied\n',
      'Consumer.hs': 'module Consumer where\nimport Prelude hiding (fmap)\nimport Facade\nimport qualified Callback as C\nrun xs = fmap C.callback xs\n',
    });
    expect(targets(current, 'run')).toContainEqual(expect.objectContaining({
      edge: expect.objectContaining({ kind: 'calls', provenance: 'heuristic' }),
      target: expect.objectContaining({ name: 'callback' }),
    }));
  });
});

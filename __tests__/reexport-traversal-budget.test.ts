import { describe, expect, it } from 'vitest';
import type { Language, Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import {
  extractImportMappings, extractReExports, haskellEffectHeadHasCanonicalOrigin,
  haskellNameHasCanonicalOrigin, resolveViaImport,
} from '../src/resolution/import-resolver';

function fixture(language: Language, sources: Record<string, string>, declarations: Node[] = []) {
  const nodes = [...declarations];
  if (language === 'haskell') {
    for (const filePath of Object.keys(sources)) {
      nodes.push(declaration(filePath.replace(/\.hs$/, ''), filePath, language, 'namespace'));
    }
  }
  const imports = new Map(Object.entries(sources).map(([file, content]) =>
    [file, extractImportMappings(file, content, language)]));
  const reExports = new Map(Object.entries(sources).map(([file, content]) =>
    [file, extractReExports(content, language)]));
  let visits = 0;
  const context: ResolutionContext = {
    getNodesInFile: (file) => nodes.filter((node) => node.filePath === file),
    getNodesByName: (name) => nodes.filter((node) => node.name === name),
    getNodesByQualifiedName: (name) => nodes.filter((node) => node.qualifiedName === name),
    getNodesByKind: (kind) => nodes.filter((node) => node.kind === kind),
    getNodesByLowerName: (name) => nodes.filter((node) => node.name.toLowerCase() === name),
    fileExists: (file) => file in sources,
    readFile: (file) => sources[file] ?? null,
    getProjectRoot: () => '/reexport-budget-fixture',
    getAllFiles: () => Object.keys(sources),
    getImportMappings: (file) => imports.get(file) ?? [],
    getReExports: (file) => {
      // Make regressions fail promptly without timing assertions or allowing
      // the deliberately exponential fixture to monopolize the test runner.
      if (++visits > 20_000) throw new Error('Re-export traversal exceeded the test safety limit');
      return reExports.get(file) ?? [];
    },
  };
  return {
    visits: () => visits,
    canonicalOrigin: (filePath: string, namespace: 'type' | 'value') => namespace === 'type'
      ? haskellEffectHeadHasCanonicalOrigin(filePath, 'IO', context)
      : haskellNameHasCanonicalOrigin(filePath, 'map', context, {
          canonicalModules: new Set(['Prelude']),
          canonicalPackages: new Map([['Prelude', new Set(['base'])]]),
          namespace: 'value', implicitPrelude: true,
        }),
    resolve: (filePath: string, name = 'wanted') => {
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: name, referenceKind: 'calls',
        filePath, language, line: 2, column: 0,
      };
      return resolveViaImport(ref, context);
    },
  };
}

function declaration(name: string, filePath: string, language: Language, kind: Node['kind'] = 'function'): Node {
  return {
    id: `${filePath}:${name}`, name, qualifiedName: `${filePath}::${name}`,
    kind, filePath, language, isExported: true,
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0,
  };
}

function diamond(language: Language, depth = 20, leafTarget = false): Record<string, string> {
  const sources: Record<string, string> = {};
  for (let level = 0; level < depth; level++) {
    for (const side of ['A', 'B']) {
      const name = `${side}${level}`;
      if (language === 'haskell') {
        sources[`${name}.hs`] = level === depth - 1
          ? leafTarget ? `module ${name} (module Origin) where\nimport Origin` : `module ${name} where`
          : `module ${name} (module A${level + 1}, module B${level + 1}) where\nimport A${level + 1}\nimport B${level + 1}`;
      } else {
        sources[`${name}.${language === 'javascript' ? 'js' : 'ts'}`] = level === depth - 1
          ? "export * from 'external-package';"
          : `export * from './A${level + 1}';\nexport * from './B${level + 1}';`;
      }
    }
  }
  return sources;
}

describe('bounded re-export traversal', () => {
  it.each(['typescript', 'javascript'] as const)('keeps missing %s diamond lookups bounded', (language) => {
    const consumer = language === 'javascript' ? 'Consumer.js' : 'Consumer.ts';
    const graph = fixture(language, {
      ...diamond(language),
      [consumer]: "import { wanted } from './A0'; wanted();",
    });
    expect(graph.resolve(consumer)).toBeNull();
    expect(graph.visits()).toBeLessThan(100);
  });

  it('bounds named re-export diamonds as well as wildcard routes', () => {
    const sources = Object.fromEntries(Object.entries(diamond('typescript'))
      .map(([file, content]) => [file, content.replace(/export \*/g, 'export { wanted }')]));
    const graph = fixture('typescript', {
      ...sources,
      'Consumer.ts': "import { wanted } from './A0'; wanted();",
    });
    expect(graph.resolve('Consumer.ts')).toBeNull();
    expect(graph.visits()).toBeLessThan(100);
  });

  it('resolves a TypeScript alternative after a converging missing branch', () => {
    const target = declaration('wanted', 'Origin.ts', 'typescript');
    const graph = fixture('typescript', {
      ...diamond('typescript'),
      'Origin.ts': 'export function wanted() {}',
      'Entry.ts': "export * from './A0';\nexport * from './Origin';",
      'Consumer.ts': "import { wanted } from './Entry'; wanted();",
    }, [target]);
    expect(graph.resolve('Consumer.ts')?.targetNodeId).toBe(target.id);
    expect(graph.visits()).toBeLessThan(100);
  });

  it.each(['absent', 'early', 'leaf'] as const)('fails closed on an expensive Haskell diamond with %s target', (placement) => {
    const target = declaration('wanted', 'Origin.hs', 'haskell');
    const graph = fixture('haskell', {
      ...diamond('haskell', 20, placement === 'leaf'),
      'Origin.hs': 'module Origin where\nwanted x = x',
      'Entry.hs': placement === 'early'
        ? 'module Entry (module Origin, module A0) where\nimport Origin\nimport A0'
        : 'module Entry (module A0) where\nimport A0',
      'Consumer.hs': 'module Consumer where\nimport Entry (wanted)\nrun = wanted 1',
      'SafeConsumer.hs': 'module SafeConsumer where\nimport Origin (wanted)\nrun = wanted 1',
    }, [target]);
    expect(graph.resolve('Consumer.hs')).toBeNull();
    const exhaustedVisits = graph.visits();
    expect(exhaustedVisits).toBeLessThanOrEqual(10_000);
    // Memoizing an incomplete search must never promote its early candidate.
    expect(graph.resolve('Consumer.hs')).toBeNull();
    expect(graph.visits()).toBe(exhaustedVisits);
    expect(graph.resolve('SafeConsumer.hs')?.targetNodeId).toBe(target.id);
  });

  it('does not select a Haskell export when a competing route exceeds the depth limit', () => {
    const sources: Record<string, string> = {};
    for (let level = 0; level < 70; level++) {
      const next = level === 69 ? 'Competitor' : `Chain${level + 1}`;
      sources[`Chain${level}.hs`] = `module Chain${level} (module ${next}) where\nimport ${next}`;
    }
    const graph = fixture('haskell', {
      ...sources,
      'Origin.hs': 'module Origin where\nwanted x = x',
      'Competitor.hs': 'module Competitor where\nwanted x = x',
      'Entry.hs': 'module Entry (module Origin, module Chain0) where\nimport Origin\nimport Chain0',
      'Consumer.hs': 'module Consumer where\nimport Entry (wanted)\nrun = wanted 1',
    }, [declaration('wanted', 'Origin.hs', 'haskell'), declaration('wanted', 'Competitor.hs', 'haskell')]);
    expect(graph.resolve('Consumer.hs')).toBeNull();
  });

  it('retains long Haskell chains within the limit', () => {
    const sources: Record<string, string> = {};
    for (let level = 0; level < 24; level++) {
      const next = level === 23 ? 'Origin' : `Chain${level + 1}`;
      sources[`Chain${level}.hs`] = `module Chain${level} (module ${next}) where\nimport ${next}`;
    }
    const target = declaration('wanted', 'Origin.hs', 'haskell');
    const graph = fixture('haskell', {
      ...sources,
      'Origin.hs': 'module Origin where\nwanted x = x',
      'Consumer.hs': 'module Consumer where\nimport Chain0 (wanted)\nrun = wanted 1',
    }, [target]);
    expect(graph.resolve('Consumer.hs')?.targetNodeId).toBe(target.id);
  });

  it('keeps restrictions local to converging Haskell branches', () => {
    const target = declaration('wanted', 'Origin.hs', 'haskell', 'field');
    target.qualifiedName = 'Origin::B::wanted';
    const graph = fixture('haskell', {
      'Origin.hs': 'module Origin where\ndata A = A\ndata B = B { wanted :: Int }',
      'Denied.hs': 'module Denied (A(..)) where\nimport Origin',
      'Allowed.hs': 'module Allowed (B(..)) where\nimport Origin',
      'Entry.hs': 'module Entry (module Denied, module Allowed) where\nimport Denied\nimport Allowed',
      'Consumer.hs': 'module Consumer where\nimport Entry (wanted)\nrun = wanted x',
    }, [target]);
    expect(graph.resolve('Consumer.hs')?.targetNodeId).toBe(target.id);
  });

  it.each(['type', 'value'] as const)('bounds canonical %s origin proofs despite an early canonical route', (namespace) => {
    const graph = fixture('haskell', {
      ...diamond('haskell'),
      'Entry.hs': 'module Entry (module Prelude, module A0) where\nimport Prelude\nimport A0',
      'Consumer.hs': 'module Consumer where\nimport Entry',
      'SafeConsumer.hs': 'module SafeConsumer where\nimport Prelude',
    });
    expect(graph.canonicalOrigin('Consumer.hs', namespace)).toBe(false);
    expect(graph.visits()).toBeLessThanOrEqual(10_000);
    expect(graph.canonicalOrigin('SafeConsumer.hs', namespace)).toBe(true);
  });

  it.each(['type', 'value'] as const)('bounds canonical %s origin proof depth while allowing ordinary facades', (namespace) => {
    const sources: Record<string, string> = {};
    for (let level = 0; level < 200; level++) {
      const next = level === 199 ? 'Prelude' : `Chain${level + 1}`;
      sources[`Chain${level}.hs`] = `module Chain${level} (module ${next}) where\nimport ${next}`;
    }
    const graph = fixture('haskell', {
      ...sources,
      'Consumer.hs': 'module Consumer where\nimport Chain0',
      'Facade.hs': 'module Facade (module Prelude) where\nimport Prelude',
      'SafeConsumer.hs': 'module SafeConsumer where\nimport Facade',
    });
    expect(graph.canonicalOrigin('Consumer.hs', namespace)).toBe(false);
    expect(graph.visits()).toBeLessThan(100);
    expect(graph.canonicalOrigin('SafeConsumer.hs', namespace)).toBe(true);
  });
});

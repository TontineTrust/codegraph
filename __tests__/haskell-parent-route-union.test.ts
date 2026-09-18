import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import type { ReExport, ResolutionContext } from '../src/resolution/types';
import { extractImportMappings, extractReExports, resolveViaImport } from '../src/resolution/import-resolver';

const declaration = (file: string, owner = '', kind: Node['kind'] = 'field'): Node => ({
  id: `${file}:${owner}:wanted`, name: 'wanted', qualifiedName: owner ? `${file}::${owner}::wanted` : `${file}::wanted`,
  filePath: `${file}.hs`, kind, language: 'haskell', isExported: true,
  startLine: 2, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 0,
});
const named = (source: string, parentExport?: string): ReExport => ({
  kind: 'named', source, exportedName: 'wanted', originalName: 'wanted',
  ...(parentExport ? { parentExport } : {}),
});
const union = (source: string) => [named(source, 'A'), named(source, 'B')];

function fixture(routes: Record<string, ReExport[]>, values: Node[], sources: Record<string, string> = {}) {
  const files: Record<string, string> = { 'Consumer.hs': 'module Consumer where\nimport Facade (wanted)', ...sources };
  for (const name of Object.keys(routes)) files[`${name}.hs`] ??= `module ${name} where`;
  for (const node of values) files[node.filePath] ??= `module ${node.filePath.slice(0, -3)} where`;
  const nodes = [...values, ...Object.keys(files).map((file): Node => ({
    ...declaration(file.slice(0, -3)), id: `${file}:module`, name: file.slice(0, -3),
    qualifiedName: file.slice(0, -3), kind: 'namespace',
  }))];
  const imports = new Map(Object.entries(files).map(([file, source]) => [file, extractImportMappings(file, source, 'haskell')]));
  const exports = new Map(Object.entries(files).map(([file, source]) => [file,
    routes[file.slice(0, -3)] ?? extractReExports(source, 'haskell')]));
  const visits = new Map<string, number>();
  const context: ResolutionContext = {
    getNodesInFile: file => nodes.filter(node => node.filePath === file),
    getNodesByName: name => nodes.filter(node => node.name === name),
    getNodesByQualifiedName: name => nodes.filter(node => node.qualifiedName === name),
    getNodesByKind: kind => nodes.filter(node => node.kind === kind),
    getNodesByLowerName: name => nodes.filter(node => node.name.toLowerCase() === name),
    fileExists: file => file in files, readFile: file => files[file] ?? null,
    getProjectRoot: () => '/haskell-parent-union-fixture', getAllFiles: () => Object.keys(files),
    getImportMappings: file => imports.get(file) ?? [],
    getReExports: file => {
      visits.set(file, (visits.get(file) ?? 0) + 1);
      if ([...visits.values()].reduce((a, b) => a + b, 0) > 10_000) throw new Error('Traversal budget exceeded');
      return exports.get(file) ?? [];
    },
  };
  return {
    visits: (file: string) => visits.get(file) ?? 0,
    resolve: (namespace: 'value' | 'type' = 'value') => resolveViaImport({
      fromNodeId: 'caller', referenceName: 'wanted', referenceKind: namespace === 'value' ? 'calls' : 'type_of',
      filePath: 'Consumer.hs', language: 'haskell', line: 2, column: 0,
    }, context)?.targetNodeId,
  };
}

describe('Haskell unions of parent-qualified named routes', () => {
  it('accepts either owner, excludes unrelated owners, and walks the source once', () => {
    const allowed = declaration('Origin', 'B');
    const graph = fixture({ Facade: [...union('Origin'), named('Origin', 'B')], Origin: [] }, [allowed, declaration('Origin', 'C')]);
    expect(graph.resolve()).toBe(allowed.id);
    expect(graph.visits('Origin.hs')).toBe(1);
  });

  it('retains ambiguity between two distinct matching owners', () => {
    const graph = fixture({ Facade: union('Origin'), Origin: [] }, [declaration('Origin', 'A'), declaration('Origin', 'B')]);
    expect(graph.resolve()).toBeUndefined();
  });

  it.each([
    { label: 'unrestricted', route: { kind: 'wildcard', source: 'Origin' } as ReExport },
    { label: 'selected', route: { kind: 'wildcard', source: 'Origin', includedParentExports: ['B', 'C'] } as ReExport },
    { label: 'collapsed', route: { kind: 'wildcard', source: 'Origin', includedParentExports: ['B', 'C'], haskellCollapsedParents: true } as ReExport },
  ])('preserves the owner union through a $label wildcard', ({ route }) => {
    const allowed = declaration('Origin', 'B');
    const graph = fixture({ Facade: union('Bridge'), Bridge: [route], Origin: [] }, [allowed, declaration('Origin', 'C')]);
    expect(graph.resolve()).toBe(allowed.id);
    expect(graph.visits('Origin.hs')).toBe(1);
  });

  it('intersects a wildcard parent selection without multiplying the union walk', () => {
    const allowed = declaration('Origin', 'B');
    const graph = fixture({ Facade: union('Bridge'), Bridge: [{ kind: 'wildcard', source: 'Origin', includedParentExports: ['A', 'B', 'C'] }], Origin: [] }, [allowed, declaration('Origin', 'C')]);
    expect(graph.resolve()).toBe(allowed.id);
    expect(graph.visits('Origin.hs')).toBe(1);
  });

  it('rejects a wildcard parent selection disjoint from the owner union', () => {
    const graph = fixture({ Facade: union('Bridge'), Bridge: [{ kind: 'wildcard', source: 'Origin', includedParentExports: ['C'] }], Origin: [] }, [declaration('Origin', 'C')]);
    expect(graph.resolve()).toBeUndefined();
    expect(graph.visits('Origin.hs')).toBe(0);
  });

  it.each([
    { label: 'named reset', route: named('Origin') },
    { label: 'compact named reset', route: { kind: 'wildcard', source: 'Origin', includedNames: ['wanted'], haskellClearParent: true } as ReExport },
    { label: 'named replacement', route: named('Origin', 'C') },
  ])('preserves $label rather than accumulating parent predicates', ({ route }) => {
    const allowed = declaration('Origin', 'C');
    const graph = fixture({ Facade: union('Bridge'), Bridge: [route], Origin: [] }, [allowed]);
    expect(graph.resolve()).toBe(allowed.id);
  });

  it('retains inherited hiding predicates around an owner union', () => {
    const allowed = declaration('Origin', 'B');
    const graph = fixture({
      Facade: [{ kind: 'wildcard', source: 'Bridge', excludedParentExports: ['A'] }],
      Bridge: union('Origin'), Origin: [],
    }, [declaration('Origin', 'A'), allowed]);
    expect(graph.resolve()).toBe(allowed.id);
  });

  it('does not merge distinct namespaces or different source modules', () => {
    const type = declaration('Origin', 'A', 'type_alias'), value = declaration('Origin', 'B');
    const graph = fixture({ Facade: [
      { ...named('Origin', 'A'), haskellTypeOnly: true },
      { ...named('Origin', 'B'), haskellValueOnly: true },
    ], Origin: [] }, [type, value], { 'Consumer.hs': 'module Consumer where\nimport Facade' });
    expect(graph.resolve('type')).toBe(type.id);
    expect(graph.resolve('value')).toBe(value.id);
    const ambiguous = fixture({ Facade: [...union('Origin'), ...union('Other')], Origin: [], Other: [] }, [value, declaration('Other', 'A')]);
    expect(ambiguous.resolve()).toBeUndefined();
  });

  it('does not merge a package-qualified parent with a home-module route', () => {
    const graph = fixture({ Facade: [named('Origin', 'B'), { ...named('Origin', 'A'), packageQualifier: 'external' }], Origin: [] }, [declaration('Origin', 'A')]);
    expect(graph.resolve()).toBeUndefined();
  });

  it('still rejects an early union target if a distinct route exhausts the budget', () => {
    const sources: Record<string, string> = {};
    for (let level = 0; level < 20; level++) {
      for (const side of ['A', 'B']) {
        const name = `${side}${level}`;
        sources[`${name}.hs`] = level === 19 ? `module ${name} where`
          : `module ${name} (module A${level + 1}, module B${level + 1}) where\nimport A${level + 1}\nimport B${level + 1}`;
      }
    }
    const graph = fixture({ Facade: [...union('Origin'), { kind: 'wildcard', source: 'A0' }], Origin: [] }, [declaration('Origin', 'A')], sources);
    expect(graph.resolve()).toBeUndefined();
  });

  it('avoids exhausting the unchanged budget on speculative individually imported children', () => {
    const sources: Record<string, string> = {
      'Facade.hs': 'module Facade (wanted, module Growth) where\nimport Growth\nwanted x = x',
      'Growth.hs': 'module Growth (P0(..), P1(..), P2(..), P3(..)) where\nimport Origin (wanted)\ndata P0 = P0\ndata P1 = P1\ndata P2 = P2\ndata P3 = P3',
      'Origin.hs': 'module Origin (wanted, module A0) where\nimport A0\nwanted x = x',
    };
    for (let level = 0; level < 11; level++) {
      for (const side of ['A', 'B']) {
        const name = `${side}${level}`;
        sources[`${name}.hs`] = level === 10 ? `module ${name} where`
          : `module ${name} (module A${level + 1}, module B${level + 1}) where\nimport A${level + 1}\nimport B${level + 1}`;
      }
    }
    const target = declaration('Facade', '', 'function');
    const graph = fixture({}, [target, declaration('Origin', '', 'function')], sources);
    expect(graph.resolve()).toBe(target.id);
    // Facade forwards Growth both by its named wanted export and module export.
    // Each independent path now visits Origin once for all four owner options.
    expect(graph.visits('Origin.hs')).toBe(2);
  });
});
